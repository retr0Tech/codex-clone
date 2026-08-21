import { eq } from "drizzle-orm";
import type { SnapshotMeta } from "@codex-clone/core";
import { snapshots, type Database } from "@codex-clone/db";

/**
 * The `snapshots` row: one per task, overwritten each time the task is reaped.
 *
 * The store is authoritative about the bytes and the DB is authoritative about
 * which tasks have a cold copy, which is why the wake path asks the store
 * (`head`) rather than this table -- a row pointing at an archive somebody
 * deleted by hand must not be able to fail a run. This is what the UI reads.
 *
 * `sizeBytes` is an `integer` column, so it tops out at 2 GB. That is a real
 * ceiling and it is the schema's, not ours: a cold snapshot that large means
 * the excludes did nothing, which is a bug worth surfacing rather than a size
 * worth supporting. It is clamped here so recording one cannot throw away a
 * snapshot that was written successfully.
 */

const MAX_RECORDED_BYTES = 2_147_483_647;

export async function recordSnapshot(db: Database, meta: SnapshotMeta, storePath: string): Promise<void> {
  const values = {
    taskId: meta.taskId,
    storePath,
    digest: meta.digest,
    sizeBytes: Math.min(meta.sizeBytes, MAX_RECORDED_BYTES),
    createdAt: new Date(meta.createdAt),
  };

  await db
    .insert(snapshots)
    .values(values)
    .onConflictDoUpdate({
      target: snapshots.taskId,
      set: { storePath: values.storePath, digest: values.digest, sizeBytes: values.sizeBytes, createdAt: values.createdAt },
    });
}

export interface SnapshotRecord {
  taskId: string;
  storePath: string;
  digest: string;
  sizeBytes: number;
  createdAt: string;
}

export async function readSnapshot(db: Database, taskId: string): Promise<SnapshotRecord | null> {
  const [row] = await db.select().from(snapshots).where(eq(snapshots.taskId, taskId)).limit(1);
  if (!row) return null;
  return {
    taskId: row.taskId,
    storePath: row.storePath,
    digest: row.digest,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}
