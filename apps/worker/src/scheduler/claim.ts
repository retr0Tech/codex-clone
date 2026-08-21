import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { InvalidCronError, nextCronRun } from "@codex-clone/cron";
import { scheduledExecutions, scheduledJobs, type Database } from "@codex-clone/db";
import type { Claim, DueJob } from "./types.js";

/**
 * The scheduler tick's claim (PLAN.md §3.5).
 *
 *   SELECT ... WHERE enabled AND next_run_at <= now() FOR UPDATE SKIP LOCKED
 *
 * The same pattern the run queue uses, for the same reason: the row lock lives
 * for the length of the transaction, so a second worker asking the identical
 * question steps over the locked row instead of blocking on it. A job cannot
 * double-fire across a worker pool, and a claim survives the worker that made
 * it dying -- because the claim is a committed row, not a timer in memory.
 *
 * Three things happen under that one lock, and they have to be atomic together
 * or the guarantees fall apart:
 *
 *   1. the overlap decision is taken,
 *   2. an execution row is written -- `claimed` if it will fire, `skipped` with
 *      a reason if it will not, because a schedule that silently did nothing is
 *      indistinguishable from one that is broken,
 *   3. `next_run_at` is advanced.
 *
 * Step 3 is where downtime is handled, and it is a single decision: the next
 * occurrence is computed from **now**, never by stepping the cron forward one
 * occurrence at a time from the stale value. A job that was due sixty times
 * while the laptop was shut therefore fires ONCE on recovery and is then back
 * on cadence. Nothing anywhere has to count how many were missed.
 */

export interface ClaimOptions {
  /**
   * How late an occurrence may be before it counts as "missed during downtime"
   * rather than "the tick ran a moment late".
   *
   * Four ticks. A schedule is not a real-time system; being a minute late is
   * normal, and being ten minutes late means something was off.
   */
  catchupGraceMs?: number;
  /** Ceiling per tick, so a hundred due jobs do not become one enormous transaction. */
  limit?: number;
  now?: Date;
  log?: (message: string) => void;
}

export const DEFAULT_CATCHUP_GRACE_MS = 120_000;
export const DEFAULT_CLAIM_LIMIT = 20;

/**
 * A `type` rather than an `interface` on purpose: drizzle's `execute<T>()`
 * constrains T to `Record<string, unknown>`, and only a type alias picks up the
 * implicit index signature that satisfies it.
 */
type DueRow = {
  id: string;
  job_name: string;
  prompt: string;
  base_branch: string;
  cron_expr: string;
  timezone: string;
  on_overlap: "skip" | "queue";
  catchup: boolean;
  auto_push_branch: boolean;
  auto_open_pr: boolean;
  next_run_at: Date | string;
  repo_id: string;
  owner: string;
  repo_name: string;
  full_name: string;
};

/**
 * Everything here needs is `execute`, and both a `Database` and the transaction
 * handle drizzle hands to a callback provide it. Naming the capability rather
 * than the concrete type is what lets `hasActiveExecution` be called from
 * inside the claim transaction AND from `runNow` outside one.
 */
type Executor = Pick<Database, "execute">;

/**
 * Claims every job that is due, deciding fire-or-skip for each.
 *
 * Returns after the transaction commits, so by the time a caller sees a
 * `fire` claim the execution row and the advanced `next_run_at` are already
 * durable. Creating the task is deliberately NOT in here: it resolves a SHA
 * over the network, and holding a row lock across a network call is how a
 * scheduler comes to block on GitHub being slow.
 */
export async function claimDueJobs(db: Database, options: ClaimOptions = {}): Promise<Claim[]> {
  const now = options.now ?? new Date();
  const graceMs = options.catchupGraceMs ?? DEFAULT_CATCHUP_GRACE_MS;
  const limit = options.limit ?? DEFAULT_CLAIM_LIMIT;
  const log = options.log ?? (() => undefined);

  return db.transaction(async (tx) => {
    const due = await tx.execute<DueRow>(sql`
      select j.id,
             j.name as job_name,
             j.prompt,
             j.base_branch,
             j.cron_expr,
             j.timezone,
             j.on_overlap,
             j.catchup,
             j.auto_push_branch,
             j.auto_open_pr,
             j.next_run_at,
             r.id as repo_id,
             r.owner,
             r.name as repo_name,
             r.full_name
      from scheduled_jobs j
      join repos r on r.id = j.repo_id
      where j.enabled = true
        -- An ISO string with an explicit cast, not a Date: the driver binds
        -- raw parameters on this path and does not serialise one for us.
        and j.next_run_at <= ${now.toISOString()}::timestamptz
      order by j.next_run_at asc
      limit ${limit}
      for update of j skip locked
    `);

    const claims: Claim[] = [];
    for (const row of due) {
      const scheduledFor = new Date(row.next_run_at);

      /**
       * The next occurrence, computed FROM NOW. This is the whole of the
       * downtime story: however many occurrences were missed, the job is put
       * back on cadence from the present moment and fires exactly once.
       *
       * An expression that no longer parses -- or one that can never happen
       * again -- would otherwise leave `next_run_at` in the past forever and
       * make this job re-claim on every single tick. Disable it, and say so on
       * an execution row where somebody will see it.
       */
      let nextRunAt: Date;
      try {
        nextRunAt = nextCronRun(row.cron_expr, row.timezone, now);
      } catch (error) {
        const reason =
          error instanceof InvalidCronError
            ? `this job was disabled: ${error.message}`
            : `this job was disabled: its schedule could not be computed (${String(error)})`;
        log(`[scheduler] disabling job ${row.id}: ${reason}`);
        await tx.insert(scheduledExecutions).values({
          id: executionId(),
          jobId: row.id,
          scheduledFor,
          status: "failed",
          reason,
        });
        await tx.update(scheduledJobs).set({ enabled: false }).where(eq(scheduledJobs.id, row.id));
        continue;
      }

      const job: DueJob = {
        jobId: row.id,
        name: row.job_name,
        repo: { id: row.repo_id, owner: row.owner, name: row.repo_name, fullName: row.full_name },
        prompt: row.prompt,
        baseBranch: row.base_branch,
        cronExpr: row.cron_expr,
        timezone: row.timezone,
        onOverlap: row.on_overlap,
        catchup: row.catchup,
        autoPushBranch: row.auto_push_branch,
        autoOpenPr: row.auto_open_pr,
        scheduledFor,
        executionId: executionId(),
      };

      const skipReason = await decide(tx, job, now, graceMs);

      await tx.insert(scheduledExecutions).values({
        id: job.executionId,
        jobId: job.jobId,
        scheduledFor,
        status: skipReason === null ? "claimed" : "skipped",
        reason: skipReason,
      });

      await tx
        .update(scheduledJobs)
        .set({ nextRunAt, ...(skipReason === null ? { lastRunAt: now } : {}) })
        .where(eq(scheduledJobs.id, job.jobId));

      claims.push(skipReason === null ? { kind: "fire", job } : { kind: "skip", job, reason: skipReason });
    }
    return claims;
  });
}

/**
 * Null to fire, or the reason not to.
 *
 * Order matters: overlap is checked first because it is the more specific
 * statement. A job that is both late and still running should say "the previous
 * execution was still running" -- that is the fact the reader can act on.
 */
async function decide(
  tx: Executor,
  job: DueJob,
  now: Date,
  graceMs: number,
): Promise<string | null> {
  if (job.onOverlap === "skip" && (await hasActiveExecution(tx, job.jobId))) {
    return "the previous execution was still running when this occurrence came due";
  }

  const lateMs = now.getTime() - job.scheduledFor.getTime();
  if (lateMs > graceMs && !job.catchup) {
    return `missed by ${formatLateness(lateMs)} while the scheduler was not running, and catch-up is off for this job`;
  }
  return null;
}

/**
 * Whether this job has an occurrence still in flight.
 *
 * `claimed` covers the window between the claim committing and the task being
 * created; `running` covers everything up to the run reaching a terminal
 * status, at which point `settle()` moves it on. Those two statuses ARE the
 * overlap rule -- there is no separate bookkeeping to fall out of step with.
 */
export async function hasActiveExecution(db: Executor, jobId: string): Promise<boolean> {
  const rows = await db.execute<{ one: number }>(sql`
    select 1 as one
    from scheduled_executions
    where job_id = ${jobId}
      and status in ('claimed', 'running')
    limit 1
  `);
  return rows.length > 0;
}

export function executionId(): string {
  return `sx_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function formatLateness(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}
