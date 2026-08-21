import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SnapshotMeta, SnapshotStore } from "@codex-clone/core";

/**
 * The cold tier on local disk (PLAN.md §3.2).
 *
 *   <snapshotsDir>/<taskId>.tar.zst    the archive
 *   <snapshotsDir>/<taskId>.json       its metadata
 *
 * It lives in `apps/worker` rather than in a package of its own for one reason:
 * the worker is the only process that can reach a Docker volume, so it is the
 * only process that will ever hold a SnapshotStore. A package would add a
 * publish boundary around a single consumer with no second implementation to
 * justify it -- and the seam that carries the cloud story is already drawn, in
 * `@codex-clone/core`, where the interface lives. Swapping this for S3 means
 * writing one more class against that interface, not moving this one.
 *
 * The stream-in / stream-out shape is deliberate and is preserved here: nothing
 * buffers a whole archive in memory, and `put` hashes as the bytes go past
 * rather than reading the file back afterwards. An S3 implementation does the
 * identical thing with a multipart upload.
 *
 * Writes are atomic. A snapshot is only ever visible once its bytes are
 * completely on disk AND its sidecar has landed, because the reaper drops the
 * hot volume immediately after `put` resolves -- so a half-written archive that
 * looked complete would be a lost workspace, not a retryable error.
 */

/** `task_<hex>` in production, `task-m8-<hex>` in the suites. Never a path. */
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

export class SnapshotNotFoundError extends SnapshotError {
  constructor(taskId: string) {
    super(`no cold snapshot for task ${taskId}`);
    this.name = "SnapshotNotFoundError";
  }
}

interface StoredMeta {
  taskId: string;
  sizeBytes: number;
  createdAt: string;
  digest: string;
}

export class FsSnapshotStore implements SnapshotStore {
  readonly #dir: string;
  readonly #now: () => Date;

  constructor(dir: string, options: { now?: () => Date } = {}) {
    this.#dir = dir;
    this.#now = options.now ?? (() => new Date());
  }

  get directory(): string {
    return this.#dir;
  }

  /** Where a task's archive lives. Recorded in `snapshots.store_path`. */
  pathFor(taskId: string): string {
    return join(this.#dir, `${assertSafe(taskId)}.tar.zst`);
  }

  #metaPath(taskId: string): string {
    return join(this.#dir, `${assertSafe(taskId)}.json`);
  }

  /**
   * Streams `src` to disk, hashing it on the way past.
   *
   * Two renames, in this order: the archive first, the sidecar second. `head()`
   * keys off the sidecar, so an interrupted `put` leaves something that reads as
   * "no snapshot" rather than as a snapshot with no bytes behind it.
   */
  async put(taskId: string, src: Readable): Promise<SnapshotMeta> {
    const id = assertSafe(taskId);
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });

    const suffix = randomBytes(6).toString("hex");
    const tmpData = join(this.#dir, `.${id}.${suffix}.part`);
    const tmpMeta = join(this.#dir, `.${id}.${suffix}.json.part`);

    const hash = createHash("sha256");
    let sizeBytes = 0;

    /**
     * Held so the failure path can wait for it to close before deleting.
     *
     * `createWriteStream` opens the file asynchronously, so when the SOURCE
     * fails immediately the rejection can reach the catch block before the
     * destination has created the file at all -- `rm` then finds nothing, the
     * open completes a tick later, and the `.part` is left behind for good.
     * A leaked temp file per failed snapshot accumulates silently in the
     * snapshots directory, which is exactly what this store promises not to do.
     */
    const dest = createWriteStream(tmpData, { mode: 0o600 });

    try {
      await pipeline(
        src,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            hash.update(chunk);
            sizeBytes += chunk.length;
            yield chunk;
          }
        },
        dest,
      );

      const meta: StoredMeta = {
        taskId: id,
        sizeBytes,
        createdAt: this.#now().toISOString(),
        digest: `sha256:${hash.digest("hex")}`,
      };

      await writeFile(tmpMeta, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
      await rename(tmpData, this.pathFor(id));
      await rename(tmpMeta, this.#metaPath(id));
      return meta;
    } catch (error) {
      // Settle the destination first, or the delete below races its open.
      await closed(dest);
      await Promise.all([rm(tmpData, { force: true }), rm(tmpMeta, { force: true })]).catch(() => undefined);
      throw error instanceof SnapshotError
        ? error
        : new SnapshotError(`could not write the cold snapshot for ${id}: ${describe(error)}`);
    }
  }

  async get(taskId: string): Promise<Readable> {
    const id = assertSafe(taskId);
    if (!(await this.head(id))) throw new SnapshotNotFoundError(id);
    return createReadStream(this.pathFor(id));
  }

  /**
   * The sidecar, or null. Also checks the archive is still there: a snapshot
   * whose bytes someone deleted by hand must read as absent, so the wake path
   * falls back to a fresh clone instead of failing the run.
   */
  async head(taskId: string): Promise<SnapshotMeta | null> {
    const id = assertSafe(taskId);
    let raw: string;
    try {
      raw = await readFile(this.#metaPath(id), "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw new SnapshotError(`could not read snapshot metadata for ${id}: ${describe(error)}`);
    }

    let parsed: StoredMeta;
    try {
      parsed = JSON.parse(raw) as StoredMeta;
    } catch {
      throw new SnapshotError(`snapshot metadata for ${id} is not valid JSON`);
    }
    if (typeof parsed.digest !== "string" || typeof parsed.sizeBytes !== "number") {
      throw new SnapshotError(`snapshot metadata for ${id} is missing digest or sizeBytes`);
    }

    try {
      await stat(this.pathFor(id));
    } catch (error) {
      if (isMissing(error)) return null;
      throw new SnapshotError(`could not stat the snapshot archive for ${id}: ${describe(error)}`);
    }

    return { taskId: id, sizeBytes: parsed.sizeBytes, createdAt: parsed.createdAt, digest: parsed.digest };
  }

  /** Idempotent: deleting a snapshot that is not there is not an error. */
  async delete(taskId: string): Promise<void> {
    const id = assertSafe(taskId);
    // Sidecar first, so a partial delete reads as "gone" rather than as a
    // snapshot pointing at bytes that are no longer there.
    await rm(this.#metaPath(id), { force: true });
    await rm(this.pathFor(id), { force: true });
  }
}

/**
 * Resolves once a write stream has finished opening and closing, however it
 * ended. Never rejects: the caller is already handling a failure and only
 * needs to know the file is no longer about to appear.
 */
function closed(stream: WriteStream): Promise<void> {
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once("close", () => resolve());
    stream.once("error", () => resolve());
    stream.destroy();
  });
}

/**
 * Task ids reach this store from an HTTP control route, so they are checked
 * before they are ever joined onto a path. `../../etc/passwd` is a task id
 * shaped exactly like any other until something says otherwise.
 */
function assertSafe(taskId: string): string {
  if (!SAFE_TASK_ID.test(taskId)) {
    throw new SnapshotError(`"${taskId}" is not a usable task id for a snapshot filename`);
  }
  return taskId;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
