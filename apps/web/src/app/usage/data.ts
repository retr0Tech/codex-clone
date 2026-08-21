import "server-only";

import { asc, eq } from "drizzle-orm";
import { repos, runs, tasks, type Database } from "@codex-clone/db";

import type { RunView } from "../../lib/types";

/**
 * Spend, per task, across everything this install has run.
 *
 * One query rather than `listTasks` plus a per-task run fetch: this page exists
 * to answer "where did the money go", so it reads every run once and groups
 * them here. Archived tasks are included -- archiving is a status change, not a
 * deletion (PLAN.md §3.10), and money spent on a task you have since archived
 * was still spent.
 */

export interface TaskSpend {
  taskId: string;
  title: string;
  repoFullName: string;
  archived: boolean;
  runs: RunView[];
  /** Newest `runs.created_at` on the task, so the list can sort by recency. */
  lastRunAt: string;
}

export async function listTaskSpend(db: Database): Promise<TaskSpend[]> {
  const rows = await db
    .select({ run: runs, task: tasks, repo: repos })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .orderBy(asc(runs.createdAt));

  const byTask = new Map<string, TaskSpend>();
  for (const row of rows) {
    let entry = byTask.get(row.task.id);
    if (!entry) {
      entry = {
        taskId: row.task.id,
        title: row.task.title,
        repoFullName: row.repo.fullName,
        archived: row.task.status === "archived",
        runs: [],
        lastRunAt: row.run.createdAt.toISOString(),
      };
      byTask.set(row.task.id, entry);
    }
    entry.runs.push({
      id: row.run.id,
      prompt: row.run.prompt,
      status: row.run.status,
      phase: row.run.phase,
      stopReason: row.run.stopReason,
      budgetBreach: row.run.budgetBreach,
      turns: row.run.turns,
      inputTokens: row.run.inputTokens,
      cachedInputTokens: row.run.cachedInputTokens,
      outputTokens: row.run.outputTokens,
      costUsd: row.run.costUsd,
      startedAt: row.run.startedAt?.toISOString() ?? null,
      endedAt: row.run.endedAt?.toISOString() ?? null,
      createdAt: row.run.createdAt.toISOString(),
    });
    // Rows arrive oldest-first, so the last one wins.
    entry.lastRunAt = row.run.createdAt.toISOString();
  }

  return [...byTask.values()].sort((a, b) => Date.parse(b.lastRunAt) - Date.parse(a.lastRunAt));
}
