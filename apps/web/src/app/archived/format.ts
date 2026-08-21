import type { TaskView } from "../../lib/types";

/**
 * The shape and the arithmetic behind the /archived page.
 *
 * Deliberately free of any `server-only` import: the server component renders
 * the total, the client component renders the per-row size, and the test runs
 * it under plain Node. Anything that touches the database lives next door in
 * `data.ts`.
 */

export interface ArchivedTask {
  task: TaskView;
  /** Null when the task was archived before it ever had a workspace. */
  snapshot: { sizeBytes: number; createdAt: string } | null;
}

/** Total bytes the cold tier is holding for archived tasks. */
export function totalSnapshotBytes(rows: ArchivedTask[]): number {
  return rows.reduce((total, row) => total + (row.snapshot?.sizeBytes ?? 0), 0);
}

/** Snapshot sizes, in the units a person reads. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
