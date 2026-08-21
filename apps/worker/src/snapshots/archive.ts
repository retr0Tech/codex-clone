import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdCompress, createZstdDecompress } from "node:zlib";
import type Docker from "dockerode";
import type { SnapshotMeta, SnapshotStore } from "@codex-clone/core";
import { ensureVolume, removeVolume, VOLUME_KIND_WORKSPACE } from "@codex-clone/sandbox-docker";
import { downloadWorkspace, uploadDirectory } from "../runner/volume-io.js";
import { pruneExcluded, type PruneResult } from "./excludes.js";
import { SnapshotError } from "./fs-store.js";

/**
 * Moving a workspace between the hot tier and the cold tier (PLAN.md §3.2).
 *
 *   ws-<taskId> ──extract──▶ host temp ──prune──▶ tar | zstd ──▶ SnapshotStore
 *                                                                     │
 *   ws-<taskId> ◀──tar, uid 10001── host temp ◀──unzstd──────────────┘
 *
 * The host cannot address a named volume directly, so both directions go
 * through the same trick milestone 5 uses to seed one: a container is CREATED
 * with the volume mounted and never started, and the tree is streamed through
 * `PUT/GET /containers/{id}/archive` (see runner/volume-io.ts). Nothing
 * executes in either direction.
 *
 * Restore replaces the volume rather than writing into it. Tar extraction adds
 * and overwrites but never deletes, so extracting a snapshot over a volume that
 * still held something would silently merge two workspaces -- and the promise
 * this milestone makes is that a restored workspace is the archived one, not a
 * superset of it.
 *
 * zstd comes from `node:zlib` (Node 22.15+), not from a `zstd` binary: a cold
 * restore that fails because a developer never ran `brew install zstd` is
 * exactly the kind of rot PLAN.md §7 risk 1 warns about.
 */

/** Ten minutes each way. Bounded, because a stalled daemon must not hang a run. */
export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 10 * 60 * 1000;

export interface SnapshotIoOptions {
  docker: Docker;
  store: SnapshotStore;
  taskId: string;
  volumeName: string;
  /** Agent image, reused as the helper for the archive endpoint. */
  image: string;
  /** Host scratch space; under CODEX_DATA_DIR, not /tmp. */
  scratchRoot: string;
  timeoutMs?: number;
  onLog?: (line: string) => void;
}

export interface SnapshotWriteResult {
  meta: SnapshotMeta;
  prune: PruneResult;
}

/**
 * Exports the hot volume to the cold store.
 *
 * Does NOT touch the volume: the caller drops it afterwards, and only after
 * this has resolved. An export that failed must leave the workspace exactly
 * where it was.
 */
export async function snapshotWorkspace(options: SnapshotIoOptions): Promise<SnapshotWriteResult> {
  assertZstd();
  const log = options.onLog ?? (() => undefined);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;

  await mkdir(options.scratchRoot, { recursive: true });
  const scratch = await mkdtemp(join(options.scratchRoot, `snap-${options.taskId}-`));

  try {
    // The excludes are applied to the EXTRACTED tree (see excludes.ts), which
    // means node_modules transits host disk on its way to being deleted. The
    // cost is one temp copy of the workspace per reap, under CODEX_DATA_DIR and
    // removed in the `finally` below. Worth it for exclusion semantics that do
    // not depend on which tar the host happens to ship.
    log(`extracting ${options.volumeName} for the cold snapshot\n`);
    await downloadWorkspace(options.docker, options.volumeName, scratch, {
      image: options.image,
      taskId: options.taskId,
      timeoutMs,
    });

    const prune = await pruneExcluded(scratch);
    if (prune.removed.length > 0) {
      log(`pruned ${prune.removed.length} excluded director(ies) (~${mb(prune.bytesRemoved)} MB)\n`);
    }
    if (prune.kept.length > 0) {
      // Worth saying out loud: it is the difference between a restored
      // workspace that matches and one that is missing committed files.
      log(`kept ${prune.kept.join(", ")}: the repository tracks content there\n`);
    }

    const tar = spawn("tar", ["-C", scratch, "-cf", "-", "."], { stdio: ["ignore", "pipe", "pipe"] });
    const compressor = createZstdCompress();

    let stderr = "";
    tar.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    tar.once("error", (err: Error) => compressor.destroy(err));
    tar.once("close", (code) => {
      // A non-zero tar leaves a TRUNCATED archive that would otherwise be
      // stored as if it were complete -- and the reaper drops the hot volume
      // the moment this resolves. Fail the put instead.
      if (code !== 0) {
        compressor.destroy(new SnapshotError(`tar exited ${code} while packing ${scratch}: ${stderr.trim()}`));
      }
    });

    tar.stdout.pipe(compressor);

    try {
      const meta = await withTimeout(
        options.store.put(options.taskId, compressor),
        timeoutMs,
        `writing the cold snapshot for ${options.taskId}`,
      );
      log(`cold snapshot written: ${mb(meta.sizeBytes)} MB, ${meta.digest.slice(0, 19)}…\n`);
      return { meta, prune };
    } catch (error) {
      tar.kill("SIGKILL");
      compressor.destroy();
      throw error;
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Restores the cold snapshot into a FRESH volume, or returns null if there is
 * none.
 *
 * Null rather than a throw is the point: a task that has been archived without
 * ever running has no snapshot, and the caller's correct response is to clone
 * from the mirror as if it were new -- not to fail the run.
 */
export async function restoreWorkspace(options: SnapshotIoOptions): Promise<SnapshotMeta | null> {
  const meta = await options.store.head(options.taskId);
  if (!meta) return null;

  assertZstd();
  const log = options.onLog ?? (() => undefined);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;

  await mkdir(options.scratchRoot, { recursive: true });
  const scratch = await mkdtemp(join(options.scratchRoot, `wake-${options.taskId}-`));

  try {
    log(`restoring ${mb(meta.sizeBytes)} MB from the cold snapshot taken ${meta.createdAt}\n`);

    const source = await options.store.get(options.taskId);
    const decompressor = createZstdDecompress();
    const tar = spawn("tar", ["-C", scratch, "-xf", "-"], { stdio: ["pipe", "ignore", "pipe"] });

    let stderr = "";
    tar.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const untarred = new Promise<void>((resolve, reject) => {
      tar.once("error", reject);
      tar.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new SnapshotError(`tar exited ${code} while unpacking into ${scratch}: ${stderr.trim()}`));
      });
    });

    decompressor.pipe(tar.stdin);

    // The digest is checked as the bytes go past, not by reading the archive a
    // second time. A corrupt snapshot must be a loud failure here rather than a
    // workspace that looks restored and is silently wrong.
    const hash = createHash("sha256");
    try {
      await withTimeout(
        Promise.all([
          pipeline(
            source,
            async function* (chunks: AsyncIterable<Buffer>) {
              for await (const chunk of chunks) {
                hash.update(chunk);
                yield chunk;
              }
            },
            decompressor,
          ),
          untarred,
        ]),
        timeoutMs,
        `restoring the cold snapshot for ${options.taskId}`,
      );
    } catch (error) {
      tar.kill("SIGKILL");
      decompressor.destroy();
      source.destroy();
      throw error;
    }

    const digest = `sha256:${hash.digest("hex")}`;
    if (digest !== meta.digest) {
      throw new SnapshotError(
        `the cold snapshot for ${options.taskId} is corrupt: expected ${meta.digest}, read ${digest}`,
      );
    }

    // Replace, do not merge. Only now -- the archive is on host disk and
    // verified, so a failure past this point is recoverable from the cold tier.
    await replaceVolumeContents({
      docker: options.docker,
      volumeName: options.volumeName,
      taskId: options.taskId,
      image: options.image,
      sourceDir: scratch,
      timeoutMs,
    });

    log(`workspace restored into ${options.volumeName}\n`);
    return meta;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Points a workspace volume at the contents of a host directory, and ONLY at
 * those contents.
 *
 * Tar extraction adds and overwrites but never deletes, so writing a tree over
 * a volume that still held an older one produces the union of the two -- a file
 * the new tree does not have would survive, and a restored workspace would
 * quietly differ from the archived one. Removing the volume first is the whole
 * point; recreating it costs a few milliseconds.
 */
export async function replaceVolumeContents(options: {
  docker: Docker;
  volumeName: string;
  taskId: string;
  image: string;
  sourceDir: string;
  timeoutMs?: number;
}): Promise<void> {
  await removeVolume(options.docker, options.volumeName, { force: true });
  await ensureVolume(options.docker, options.volumeName, {
    kind: VOLUME_KIND_WORKSPACE,
    taskId: options.taskId,
  });
  await uploadDirectory(options.docker, options.volumeName, options.sourceDir, {
    image: options.image,
    taskId: options.taskId,
    timeoutMs: options.timeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS,
  });
}

/**
 * Node gained zstd in 22.15. `engines` already says 22+, so this is a clearer
 * failure than `createZstdCompress is not a function` from inside a stream.
 */
function assertZstd(): void {
  if (typeof createZstdCompress !== "function" || typeof createZstdDecompress !== "function") {
    throw new SnapshotError(
      `this Node build has no zstd support in node:zlib (running ${process.version}); Node 22.15 or newer is required for cold snapshots`,
    );
  }
}

function mb(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SnapshotError(`${what} did not finish within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
