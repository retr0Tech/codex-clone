import type { Readable } from "node:stream";

/**
 * Cold tier of the two-tier workspace store.
 *
 *   HOT   docker volume ws-<taskId>   live /workspace, free per-turn
 *           | idle reap
 *   COLD  SnapshotStore <taskId>.tar.zst
 *           | wake
 *         restore + re-run setup script
 *
 * Local filesystem today, S3 later -- the interface is deliberately a
 * stream in / stream out so an object store drops straight in.
 *
 * NOTE: the cold path only executes on wake-after-reap, which makes it a
 * rarely-run code path and therefore a rotting one. There is a reap/wake
 * integration test guarding it; keep it green.
 */

export interface SnapshotMeta {
  taskId: string;
  sizeBytes: number;
  createdAt: string;
  /** Content hash, for integrity checks and future dedupe. */
  digest: string;
}

/**
 * Excluded from the archive: restored by re-running the repo setup script.
 * Keeping these out is what makes cold snapshots megabytes not gigabytes.
 */
export const SNAPSHOT_EXCLUDES = [
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "dist",
  "build",
  "target",
  ".pnpm-store",
  ".cache",
] as const;

export interface SnapshotStore {
  /** `src` is a tar.zst stream of /workspace, excludes already applied. */
  put(taskId: string, src: Readable): Promise<SnapshotMeta>;
  get(taskId: string): Promise<Readable>;
  head(taskId: string): Promise<SnapshotMeta | null>;
  delete(taskId: string): Promise<void>;
}
