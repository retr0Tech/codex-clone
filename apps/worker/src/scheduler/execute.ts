import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { redact } from "@codex-clone/core";
import { runs, scheduledExecutions, tasks } from "@codex-clone/db";
import type { DueJob, SchedulerDeps } from "./types.js";

/**
 * Turning a claimed occurrence into work.
 *
 * The whole of it is two rows and a branch name, and that is the point: a
 * scheduled execution is an ordinary task with an ordinary queued run. The
 * worker's existing claim loop picks it up, the existing supervisor runs it in
 * the existing sandbox, and the existing publish path pushes the result. There
 * is no second execution path to keep in step with the first one.
 *
 *   scheduled_jobs ──tick──▶ scheduled_executions ──▶ tasks + runs(queued)
 *                                                          │
 *                                        the milestone 5 run loop, unchanged
 *
 * **Every execution gets a brand-new task**, and therefore a brand-new
 * `ws-<taskId>` volume that has never existed before. That is the explicit
 * requirement -- an unattended job must not inherit whatever the last one left
 * in the workspace -- and it falls out for free: the supervisor seeds a volume
 * from the mirror whenever `tasks.volume_name` is null, which for a task
 * created three lines ago it always is. There is no code path by which a
 * scheduled execution can reuse a warm workspace, because there is no task for
 * it to reuse one from.
 */

export class FireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FireError";
  }
}

export interface FiredExecution {
  executionId: string;
  taskId: string;
  runId: string;
  baseSha: string;
  workBranch: string;
}

/**
 * Creates the fresh task and queues its run.
 *
 * The base SHA is resolved HERE rather than being carried on the job: a
 * schedule that pinned a SHA at creation would run the same commit forever,
 * which is the opposite of what a nightly job is for.
 */
export async function fireJob(deps: SchedulerDeps, job: DueJob): Promise<FiredExecution> {
  let baseSha: string;
  try {
    baseSha = await deps.resolveBaseSha(job.repo, job.baseBranch);
  } catch (error) {
    throw new FireError(
      `could not resolve ${job.repo.fullName}@${job.baseBranch}: ${redact(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
  }
  if (typeof baseSha !== "string" || baseSha.trim() === "") {
    throw new FireError(`${job.repo.fullName}@${job.baseBranch} resolved to no commit at all`);
  }

  const taskId = `task_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const workBranch = scheduledBranchName(job.name, job.scheduledFor);

  await deps.db.transaction(async (tx) => {
    await tx.insert(tasks).values({
      id: taskId,
      repoId: job.repo.id,
      title: `${job.name} · ${stamp(job.scheduledFor)}`,
      mode: "code",
      baseBranch: job.baseBranch,
      baseSha,
      // Set up front so the run pushes to `scheduled/<job>/<timestamp>` rather
      // than to the `codex/<slug>` name the supervisor would otherwise invent.
      // volume_name stays null: that is what makes the workspace a fresh one.
      workBranch,
      status: "queued",
    });
    await tx.insert(runs).values({
      id: runId,
      taskId,
      prompt: job.prompt,
      status: "queued",
      // The back-link the task page reads to say "this came from a schedule".
      scheduledExecutionId: job.executionId,
    });
    await tx
      .update(scheduledExecutions)
      .set({ taskId, status: "running" })
      .where(eq(scheduledExecutions.id, job.executionId));
  });

  deps.log?.(
    `[scheduler] job ${job.name} fired occurrence ${stamp(job.scheduledFor)} as task ${taskId.slice(0, 12)} on ${workBranch}`,
  );
  return { executionId: job.executionId, taskId, runId, baseSha, workBranch };
}

/** Records a claimed occurrence that could not be turned into a task. */
export async function failExecution(deps: SchedulerDeps, executionId: string, reason: string): Promise<void> {
  await deps.db
    .update(scheduledExecutions)
    .set({ status: "failed", reason: redact(reason) })
    .where(eq(scheduledExecutions.id, executionId));
}

/**
 * `scheduled/<job>/<timestamp>` (PLAN.md §3.5).
 *
 * Namespaced under `scheduled/` so `git branch -r` says at a glance which
 * branches nobody was watching being made, and stamped with the OCCURRENCE
 * rather than with the moment the container happened to start -- so the branch
 * for the 03:00 run is called 03:00 even when the queue was busy until 03:20.
 */
export function scheduledBranchName(jobName: string, scheduledFor: Date): string {
  const slug =
    jobName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "job";
  return `scheduled/${slug}/${stamp(scheduledFor)}`;
}

/**
 * `20260821T030000Z`.
 *
 * UTC and colon-free: a git ref may not contain `:`, and a local-time stamp on
 * an unattended branch is ambiguous twice a year.
 */
function stamp(when: Date): string {
  return `${when.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}
