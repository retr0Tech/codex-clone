import { eq, sql } from "drizzle-orm";
import { runs, tasks, type Database } from "@codex-clone/db";

/**
 * The run queue.
 *
 * `FOR UPDATE SKIP LOCKED` is the same claim the scheduler uses (PLAN.md §3.5
 * and §3.9): the row lock is held for the length of the transaction, and any
 * other worker asking the same question in that window steps over the locked
 * row instead of blocking on it. That is what makes a worker POOL safe without
 * a broker, and it is why the queue lives in Postgres rather than in memory --
 * a claim survives the worker that made it dying.
 *
 * `runs_claim_idx(status, created_at)` is the index this query is shaped for.
 */

export interface ClaimedRun {
  runId: string;
  taskId: string;
  prompt: string;
}

/**
 * Claims the oldest queued run, or returns null when there is nothing to do.
 *
 * Two conditions beyond "is queued":
 *
 *  - a task with a run already in flight is skipped, so a follow-up turn
 *    queues behind its predecessor instead of racing it into the same
 *    workspace volume;
 *  - the task itself must not be archived.
 *
 * The status flip to `running` happens inside the same transaction as the
 * lock, so a run is either unclaimed or visibly claimed -- never both.
 */
export async function claimNextRun(db: Database, workerId: string): Promise<ClaimedRun | null> {
  return db.transaction(async (tx) => {
    const claimable = await tx.execute<{ id: string; task_id: string; prompt: string }>(sql`
      select r.id, r.task_id, r.prompt
      from runs r
      join tasks t on t.id = r.task_id
      where r.status = 'queued'
        and t.status <> 'archived'
        and not exists (
          select 1 from runs sibling
          where sibling.task_id = r.task_id and sibling.status = 'running'
        )
      order by r.created_at asc
      limit 1
      for update of r skip locked
    `);

    const row = claimable[0];
    if (!row) return null;

    await tx
      .update(runs)
      .set({ status: "running", phase: "setup", claimedBy: workerId, startedAt: new Date() })
      .where(eq(runs.id, row.id));
    await tx
      .update(tasks)
      .set({ status: "running", lastActivityAt: new Date() })
      .where(eq(tasks.id, row.task_id));

    return { runId: row.id, taskId: row.task_id, prompt: row.prompt };
  });
}

export interface InFlightRun {
  runId: string;
  taskId: string;
  prompt: string;
  sandboxId: string | null;
}

/**
 * Runs that are marked `running` in the database right now.
 *
 * Read on boot and partitioned against `SandboxProvider.list()`: the ones whose
 * container is still alive are re-adopted (attach replays the log from seq 0,
 * and the event log is idempotent, so adoption is safe); the rest are finished
 * with a visible reason rather than left looking busy forever. PLAN.md §7 lists
 * losing this stream on a worker restart as risk 5.
 */
export async function inFlightRuns(db: Database): Promise<InFlightRun[]> {
  const rows = await db
    .select({ id: runs.id, taskId: runs.taskId, prompt: runs.prompt, sandboxId: runs.sandboxId })
    .from(runs)
    .where(eq(runs.status, "running"));
  return rows.map((row) => ({
    runId: row.id,
    taskId: row.taskId,
    prompt: row.prompt,
    sandboxId: row.sandboxId,
  }));
}
