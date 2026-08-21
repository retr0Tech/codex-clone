import { and, eq, inArray, sql } from "drizzle-orm";
import { redact } from "@codex-clone/core";
import { scheduledExecutions, type Database } from "@codex-clone/db";
import { PublishError } from "../runner/publish.js";
import type { ExecutionStatus, SchedulerDeps } from "./types.js";

/**
 * Closing out occurrences whose run has finished.
 *
 * This is the half of the scheduler that is easy to forget and impossible to do
 * without, because `claimed` and `running` ARE the overlap rule: an execution
 * that never becomes terminal blocks its job forever. Settling therefore has to
 * be as durable as claiming -- it runs on every tick, from a query rather than
 * from a callback, so a worker that was restarted mid-run picks up exactly
 * where the dead one left off.
 *
 *   run reaches a terminal status
 *        │
 *        ├─ succeeded + auto_push  ──▶ publishTask()  ──▶ branch, maybe a PR
 *        │                              (milestone 7, unchanged)
 *        ▼
 *   execution: succeeded / failed, with a reason a human can read
 *
 * Auto-push lives here rather than in the supervisor for a reason worth
 * stating: pushing rewrites `.git` inside the workspace volume, so it must not
 * happen under a live agent. Waiting for the run to be terminal is not a
 * convenience, it is the safety property.
 *
 * > **Risk accepted.** Two workers settling the same execution at the same
 * > instant could both call publish. The status write is a compare-and-set so
 * > only one of them records the outcome, and the push itself is idempotent --
 * > the second finds nothing to commit and the pull request call returns the
 * > one already open. It is a wasted extraction, not a wrong result.
 */

export interface SettleOptions {
  /**
   * How long an execution may sit in `claimed` with no task before it is
   * written off. It means the worker died between the claim committing and the
   * task being created -- a small window, but one that would otherwise block
   * the job's next occurrence forever.
   */
  staleClaimMs?: number;
  limit?: number;
}

export const DEFAULT_STALE_CLAIM_MS = 5 * 60 * 1000;
export const DEFAULT_SETTLE_LIMIT = 50;

export interface SettledExecution {
  executionId: string;
  jobName: string;
  status: Extract<ExecutionStatus, "succeeded" | "failed">;
  reason: string | null;
}

/** A type alias, not an interface: see the note in `claim.ts`. */
type PendingRow = {
  id: string;
  job_name: string;
  task_id: string | null;
  status: "claimed" | "running";
  created_at: Date | string;
  auto_push_branch: boolean;
  auto_open_pr: boolean;
  run_id: string | null;
  run_status: string | null;
  stop_reason: string | null;
};

/** Guards against a single worker settling the same execution twice concurrently. */
const settling = new Set<string>();

export async function settleExecutions(
  deps: SchedulerDeps,
  options: SettleOptions = {},
): Promise<SettledExecution[]> {
  const now = deps.now?.() ?? new Date();
  const staleMs = options.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;
  const log = deps.log ?? (() => undefined);

  const pending = await deps.db.execute<PendingRow>(sql`
    select se.id,
           j.name as job_name,
           se.task_id,
           se.status,
           se.created_at,
           j.auto_push_branch,
           j.auto_open_pr,
           r.id as run_id,
           r.status as run_status,
           r.stop_reason
    from scheduled_executions se
    join scheduled_jobs j on j.id = se.job_id
    left join runs r on r.scheduled_execution_id = se.id
    where se.status in ('claimed', 'running')
    order by se.created_at asc
    limit ${options.limit ?? DEFAULT_SETTLE_LIMIT}
  `);

  const settled: SettledExecution[] = [];
  for (const row of pending) {
    if (settling.has(row.id)) continue;

    const outcome = await resolveOutcome(deps, row, now, staleMs, log);
    if (!outcome) continue;

    const claimed = await finish(deps.db, row.id, outcome.status, outcome.reason);
    if (!claimed) continue;
    log(
      `[scheduler] execution ${row.id.slice(0, 10)} of "${row.job_name}" ${outcome.status}` +
        `${outcome.reason ? `: ${outcome.reason}` : ""}`,
    );
    settled.push({ executionId: row.id, jobName: row.job_name, ...outcome });
  }
  return settled;
}

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out", "budget_exhausted"]);

interface Outcome {
  status: Extract<ExecutionStatus, "succeeded" | "failed">;
  reason: string | null;
}

/** Null means "still in flight; leave it alone". */
async function resolveOutcome(
  deps: SchedulerDeps,
  row: PendingRow,
  now: Date,
  staleMs: number,
  log: (message: string) => void,
): Promise<Outcome | null> {
  if (!row.run_id) {
    // No run at all. Either the claim is seconds old and `fireJob` is still
    // running, or the worker died in that window and nobody ever will.
    const age = now.getTime() - new Date(row.created_at).getTime();
    if (age < staleMs) return null;
    return {
      status: "failed",
      reason: "the scheduler claimed this occurrence but no task was ever created for it",
    };
  }

  if (!row.run_status || !TERMINAL_RUN_STATUSES.has(row.run_status)) return null;

  if (row.run_status !== "succeeded") {
    return { status: "failed", reason: row.stop_reason ?? `the run ended ${row.run_status}` };
  }

  if (!row.auto_push_branch) {
    return { status: "succeeded", reason: "the run finished; auto-push is off, so the work is in its workspace" };
  }
  if (!row.task_id) {
    return { status: "failed", reason: "the run succeeded but the execution has no task to publish" };
  }
  if (!deps.publish) {
    return {
      status: "failed",
      reason: "the run succeeded but this worker has no publish path configured, so nothing was pushed",
    };
  }

  /**
   * The push. Held outside any transaction on purpose: it extracts a Docker
   * volume and talks to GitHub, and a row lock across that is a scheduler that
   * stalls whenever the network does.
   */
  settling.add(row.id);
  try {
    const result = await deps.publish(row.task_id, { openPullRequest: row.auto_open_pr });
    const pieces = [`pushed ${result.branch} (${result.filesChanged} file(s))`];
    if (result.pullRequest) pieces.push(`pull request ${result.pullRequest.url}`);
    return { status: "succeeded", reason: pieces.join(" · ") };
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    // "Nothing to push" is a fine outcome for a nightly job: the agent looked
    // and found nothing to change. Saying so is not the same as failing.
    if (error instanceof PublishError && /nothing to push/i.test(message)) {
      return { status: "succeeded", reason: "the run made no changes, so there was nothing to push" };
    }
    log(`[scheduler] auto-push failed for execution ${row.id.slice(0, 10)}: ${message}`);
    // An unattended diff that dies with its container is worthless (PLAN.md
    // §3.5), so a push that did not happen is a failed occurrence even though
    // the agent itself succeeded.
    return { status: "failed", reason: `the run succeeded but the push failed: ${message}` };
  } finally {
    settling.delete(row.id);
  }
}

/**
 * Compare-and-set: the status only moves if this caller is the one that found
 * it in flight. A second worker that raced to the same conclusion writes
 * nothing and reports nothing.
 */
async function finish(
  db: Database,
  executionId: string,
  status: Extract<ExecutionStatus, "succeeded" | "failed">,
  reason: string | null,
): Promise<boolean> {
  const updated = await db
    .update(scheduledExecutions)
    .set({ status, reason })
    .where(
      and(
        eq(scheduledExecutions.id, executionId),
        inArray(scheduledExecutions.status, ["claimed", "running"]),
      ),
    )
    .returning({ id: scheduledExecutions.id });
  return updated.length > 0;
}
