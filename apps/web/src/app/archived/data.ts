import "server-only";

import { desc } from "drizzle-orm";
import { snapshots, type Database } from "@codex-clone/db";

import { listTasks } from "../api/_lib/tasks";
import type { ArchivedTask } from "./format";

/**
 * The archived list, with the cold snapshot each task is holding.
 *
 * Read here rather than folded into `TaskView` because this is the only page
 * that cares: the sidebar and the task page have no use for an archive size,
 * and widening the shared view type for one screen is how a REST shape ends up
 * carrying five fields nothing reads.
 *
 * The size is the honest answer to "what did archiving actually buy me" -- it
 * is the megabytes still on disk after the Docker volume went away.
 */
export async function listArchivedTasks(db: Database): Promise<ArchivedTask[]> {
  const [all, records] = await Promise.all([
    listTasks(db, true),
    db.select().from(snapshots).orderBy(desc(snapshots.createdAt)),
  ]);

  const byTask = new Map(records.map((row) => [row.taskId, row]));
  return all
    .filter((task) => task.status === "archived")
    .map((task) => {
      const record = byTask.get(task.id);
      return {
        task,
        snapshot: record ? { sizeBytes: record.sizeBytes, createdAt: record.createdAt.toISOString() } : null,
      };
    });
}
