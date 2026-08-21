import { eq } from "drizzle-orm";
import type { BudgetBreach, RunPhase, RunStatus } from "@codex-clone/core";
import { repos, runs, tasks, type Database } from "@codex-clone/db";
import type { RunMeterSnapshot } from "../gateway/metering.js";

/**
 * Everything the run loop writes back to `runs` and `tasks`.
 *
 * Kept apart from the supervision flow so the flow reads as a sequence of
 * steps, and so the state transitions are in one place where they can be
 * checked against the enums in the schema.
 */

export interface TaskContext {
  taskId: string;
  title: string;
  mode: "ask" | "code";
  baseBranch: string;
  baseSha: string;
  workBranch: string | null;
  volumeName: string | null;
  repo: { id: string; owner: string; name: string; fullName: string; setupScript: string | null };
}

export async function loadTaskContext(db: Database, taskId: string): Promise<TaskContext | null> {
  const [row] = await db
    .select({
      task: tasks,
      repo: repos,
    })
    .from(tasks)
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .where(eq(tasks.id, taskId))
    .limit(1);

  if (!row) return null;
  return {
    taskId: row.task.id,
    title: row.task.title,
    mode: row.task.mode,
    baseBranch: row.task.baseBranch,
    baseSha: row.task.baseSha,
    workBranch: row.task.workBranch,
    volumeName: row.task.volumeName,
    repo: {
      id: row.repo.id,
      owner: row.repo.owner,
      name: row.repo.name,
      fullName: row.repo.fullName,
      setupScript: row.repo.setupScript,
    },
  };
}

export async function setRunPhase(db: Database, runId: string, phase: RunPhase): Promise<void> {
  await db.update(runs).set({ phase }).where(eq(runs.id, runId));
}

export async function setRunSandbox(db: Database, runId: string, sandboxId: string): Promise<void> {
  await db.update(runs).set({ sandboxId }).where(eq(runs.id, runId));
}

/**
 * Records the workspace volume on the task, which doubles as the "this task has
 * been seeded" marker: a follow-up turn sees it set and reuses the warm volume
 * instead of re-cloning over the agent's work.
 */
export async function recordVolume(db: Database, taskId: string, volumeName: string, workBranch: string): Promise<void> {
  await db.update(tasks).set({ volumeName, workBranch }).where(eq(tasks.id, taskId));
}

/**
 * Per-turn cost accounting, straight from the gateway meter.
 *
 * The gateway is the only component that sees every model call, so it is the
 * only honest source for these numbers (PLAN.md §3.3).
 */
export async function recordUsage(db: Database, runId: string, snapshot: RunMeterSnapshot): Promise<void> {
  await db
    .update(runs)
    .set({
      turns: snapshot.turns,
      inputTokens: snapshot.inputTokens,
      cachedInputTokens: snapshot.cachedInputTokens,
      outputTokens: snapshot.outputTokens,
      costUsd: snapshot.costUsd,
    })
    .where(eq(runs.id, runId));
}

export interface FinalizeRun {
  status: RunStatus;
  stopReason: string | null;
  /**
   * The bound that stopped this run, or null. Written explicitly rather than
   * inferred later: a cancelled run and a run that hit its cost ceiling can end
   * up with similar-looking numbers, and only the run loop knows which happened.
   */
  budgetBreach?: BudgetBreach | null;
  usage?: RunMeterSnapshot | null;
}

/**
 * Terminal state, in one write.
 *
 * The task returns to `idle` rather than being deleted or hidden: PLAN.md §3.10
 * makes archival a status change, and a finished task is simply a task with no
 * run in flight.
 */
export async function finalizeRun(db: Database, runId: string, taskId: string, result: FinalizeRun): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(runs)
      .set({
        status: result.status,
        phase: "done",
        stopReason: result.stopReason,
        budgetBreach: result.budgetBreach ?? null,
        endedAt: new Date(),
        ...(result.usage
          ? {
              turns: result.usage.turns,
              inputTokens: result.usage.inputTokens,
              cachedInputTokens: result.usage.cachedInputTokens,
              outputTokens: result.usage.outputTokens,
              costUsd: result.usage.costUsd,
            }
          : {}),
      })
      .where(eq(runs.id, runId));

    const [task] = await tx.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (task && task.status !== "archived") {
      await tx.update(tasks).set({ status: "idle", lastActivityAt: new Date() }).where(eq(tasks.id, taskId));
    }
  });
}
