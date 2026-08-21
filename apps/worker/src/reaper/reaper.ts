import { join } from "node:path";
import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";
import type Docker from "dockerode";
import type { SnapshotMeta, SnapshotStore } from "@codex-clone/core";
import { redact } from "@codex-clone/core";
import { removeVolume } from "@codex-clone/sandbox-docker";
import { runs, tasks, type Database } from "@codex-clone/db";
import { snapshotWorkspace } from "../snapshots/archive.js";
import { recordSnapshot } from "../snapshots/record.js";

/**
 * The idle reaper (PLAN.md §3.1).
 *
 *   turn 1 → create → run → keep the volume warm
 *   turn 2 → reuse (fast) → run
 *      …idleReapMs…
 *   THIS  → export cold snapshot → drop the hot volume
 *   turn 3 → restore from cold → run
 *
 * Two rules it exists to obey, and both are ordering rules:
 *
 *  1. **The snapshot lands before the volume goes.** Never the other way round,
 *     and never in parallel. An export that fails leaves the workspace exactly
 *     where it was, and the sweep retries next tick.
 *
 *  2. **Never reap a task with a run in flight.** Checked three ways, because
 *     each covers a case the others do not: `tasks.status`, an `exists` on the
 *     `runs` table (another worker's claim), and the queue's own in-memory view
 *     (this worker, between claim and status write).
 *
 * The gap between "decide to reap" and "drop the volume" is minutes wide -- a
 * multi-gigabyte tar -- and a follow-up turn can be queued anywhere inside it.
 * So the write that clears `volume_name` is conditional on the task looking
 * EXACTLY as it did when the sweep chose it: same status, same volume, same
 * `last_activity_at`. A follow-up bumps that timestamp, so the update matches
 * nothing and the reap aborts with the workspace intact. The snapshot it
 * already wrote is simply an older cold copy, which is harmless.
 */

export type ReapTrigger = "idle" | "archive";

/**
 * The task is busy. A skip for the sweep, a 409 for the archive route -- the
 * user asked for something that cannot be honoured yet, and saying so beats
 * archiving a workspace out from under a live container.
 */
export class ReapBusyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ReapBusyError";
  }
}

export interface ReapOutcome {
  taskId: string;
  reaped: boolean;
  /** Why nothing happened. Null when `reaped` is true. */
  skipped: string | null;
  meta: SnapshotMeta | null;
}

export interface ReaperDeps {
  db: Database;
  docker: Docker;
  store: SnapshotStore;
  config: {
    image: string;
    dataDir: string;
    /** Idle time before a workspace moves to the cold tier. */
    idleReapMs: number;
    /** How often to look. Defaults to a minute. */
    pollMs?: number;
    snapshotTimeoutMs?: number;
  };
  /**
   * Whether THIS worker is running something for the task right now.
   *
   * The database says `running` only after the claim transaction commits, and
   * the queue knows a fraction of a second earlier. Cheap to ask, and it closes
   * the one window the SQL guard cannot see.
   */
  isRunning?: (taskId: string) => boolean;
  log?: (message: string) => void;
}

interface Candidate {
  taskId: string;
  volumeName: string;
  lastActivityAt: Date;
  status: string;
}

/** A minute: `idleReapMs` is measured in minutes, so this is precise enough. */
export const DEFAULT_REAPER_POLL_MS = 60_000;

export class IdleReaper {
  #timer: NodeJS.Timeout | null = null;
  #stopping = false;
  #sweeping: Promise<ReapOutcome[]> | null = null;

  constructor(private readonly deps: ReaperDeps) {}

  start(): void {
    if (this.#timer) return;
    this.#stopping = false;
    const tick = () => {
      void this.sweep()
        .catch((err: unknown) => {
          this.#log(`[reaper] sweep failed: ${redact(String(err))}`);
          return [];
        })
        .finally(() => {
          if (this.#stopping) return;
          this.#timer = setTimeout(tick, this.deps.config.pollMs ?? DEFAULT_REAPER_POLL_MS);
          // The reaper must never be the reason the process refuses to exit.
          this.#timer.unref();
        });
    };
    this.#timer = setTimeout(tick, this.deps.config.pollMs ?? DEFAULT_REAPER_POLL_MS);
    this.#timer.unref();
  }

  /** Stops sweeping and waits for the one in flight, so a shutdown cannot
   *  interrupt an export between the snapshot and the volume removal. */
  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#sweeping?.catch(() => undefined);
  }

  /**
   * One pass. Exposed rather than private because the reap/wake integration
   * test drives it directly: a test that waited fifteen real minutes for a
   * timer would be a test nobody runs, and the path it guards is already the
   * one PLAN.md §7 says rots.
   */
  async sweep(): Promise<ReapOutcome[]> {
    if (this.#sweeping) return this.#sweeping;
    const work = this.#sweep().finally(() => {
      this.#sweeping = null;
    });
    this.#sweeping = work;
    return work;
  }

  async #sweep(): Promise<ReapOutcome[]> {
    const candidates = await idleCandidates(this.deps.db, this.deps.config.idleReapMs);
    const outcomes: ReapOutcome[] = [];

    for (const candidate of candidates) {
      if (this.#stopping) break;
      try {
        outcomes.push(await reapTask(this.deps, candidate.taskId, { trigger: "idle" }));
      } catch (error) {
        const reason = redact(error instanceof Error ? error.message : String(error));
        // A task that got busy between the query and the reap is the sweep
        // working, not the sweep failing. Everything else is worth a line: one
        // workspace that will not export must not stop the others or take the
        // worker down, and it is retried next tick either way.
        if (!(error instanceof ReapBusyError)) {
          this.#log(`[reaper] could not reap ${candidate.taskId.slice(0, 8)}: ${reason}`);
        }
        outcomes.push({ taskId: candidate.taskId, reaped: false, skipped: reason, meta: null });
      }
    }
    return outcomes;
  }

  #log(message: string): void {
    this.deps.log?.(message);
  }
}

/**
 * Tasks whose hot volume has been sitting unused for longer than the TTL.
 *
 * `status = 'idle'` rather than `<> 'running'`: a queued task is about to be
 * claimed, and reaping a workspace out from under a run that is seconds from
 * starting is the same bug as reaping one mid-run, just harder to reproduce.
 */
export async function idleCandidates(db: Database, idleReapMs: number): Promise<Candidate[]> {
  const cutoff = new Date(Date.now() - idleReapMs);
  const rows = await db
    .select({
      taskId: tasks.id,
      volumeName: tasks.volumeName,
      lastActivityAt: tasks.lastActivityAt,
      status: tasks.status,
    })
    .from(tasks)
    .where(and(isNotNull(tasks.volumeName), eq(tasks.status, "idle"), lte(tasks.lastActivityAt, cutoff)));

  return rows.flatMap((row) =>
    row.volumeName === null
      ? []
      : [{ taskId: row.taskId, volumeName: row.volumeName, lastActivityAt: row.lastActivityAt, status: row.status }],
  );
}

export interface ReapOptions {
  trigger: ReapTrigger;
  /** Archiving reaps immediately; the idle TTL does not apply to it. */
  ignoreIdleTime?: boolean;
  /** Applied to the task row in the same write that clears `volume_name`. */
  alsoSet?: Partial<typeof tasks.$inferInsert>;
  onLog?: (line: string) => void;
}

/**
 * Exports one task's workspace to the cold tier and drops the hot volume.
 *
 * Returns rather than throws for every "nothing to do here" case: a task with
 * no workspace, or one that became busy while the tar was running, is a normal
 * outcome of a sweep and not an error anybody should see.
 */
export async function reapTask(deps: ReaperDeps, taskId: string, options: ReapOptions): Promise<ReapOutcome> {
  const log = deps.log ?? (() => undefined);
  const nothing = (skipped: string): ReapOutcome => ({ taskId, reaped: false, skipped, meta: null });

  const [task] = await deps.db
    .select({
      volumeName: tasks.volumeName,
      status: tasks.status,
      lastActivityAt: tasks.lastActivityAt,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  if (!task) return nothing(`no task ${taskId}`);

  // Before anything, including the pure status change: archiving a task whose
  // agent is mid-turn would leave a container writing into a workspace the UI
  // says is gone.
  const busy = await runInFlight(deps, taskId);
  if (busy) throw new ReapBusyError(busy);

  if (task.volumeName === null) {
    // Already cold, or never ran. `alsoSet` still has to land -- that is how
    // archiving a task that was reaped an hour ago still archives it.
    if (options.alsoSet) {
      await deps.db.update(tasks).set(options.alsoSet).where(eq(tasks.id, taskId));
    }
    return nothing("this task has no hot workspace");
  }

  if (!options.ignoreIdleTime) {
    const idleFor = Date.now() - task.lastActivityAt.getTime();
    if (idleFor < deps.config.idleReapMs) return nothing(`only idle for ${Math.round(idleFor / 1000)}s`);
  }

  const volumeName = task.volumeName;
  log(`[reaper] ${options.trigger}: exporting ${volumeName} to the cold snapshot store`);

  const { meta } = await snapshotWorkspace({
    docker: deps.docker,
    store: deps.store,
    taskId,
    volumeName,
    image: deps.config.image,
    scratchRoot: join(deps.config.dataDir, "snapshot-staging"),
    ...(deps.config.snapshotTimeoutMs === undefined ? {} : { timeoutMs: deps.config.snapshotTimeoutMs }),
    onLog: (line) => {
      log(`[reaper ${taskId.slice(0, 8)}] ${line.trimEnd()}`);
      options.onLog?.(line);
    },
  });

  await recordSnapshot(deps.db, meta, storePathOf(deps.store, taskId));

  // The conditional write. Nothing about the task may have changed since the
  // sweep looked at it -- a follow-up moves `last_activity_at`, a claim moves
  // `status`, and either means somebody is about to use this volume.
  const claimed = await deps.db
    .update(tasks)
    .set({ volumeName: null, ...(options.alsoSet ?? {}) })
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.volumeName, volumeName),
        eq(tasks.status, "idle"),
        eq(tasks.lastActivityAt, task.lastActivityAt),
      ),
    )
    .returning({ id: tasks.id });

  if (claimed.length === 0) {
    log(`[reaper] ${taskId.slice(0, 8)} became busy during the export; keeping the hot workspace`);
    return nothing("the task became busy while its snapshot was being written");
  }

  // Only now. The row says "cold" and the snapshot is on disk, so even if this
  // fails the workspace is recoverable -- and `restoreWorkspace` force-replaces
  // the volume on wake, so a straggler cannot become a merged workspace.
  try {
    await removeVolume(deps.docker, volumeName, { force: true });
  } catch (error) {
    log(`[reaper] snapshot for ${taskId.slice(0, 8)} is safe, but ${volumeName} would not go: ${redact(String(error))}`);
  }

  log(`[reaper] ${taskId.slice(0, 8)} is cold: ${(meta.sizeBytes / 1_048_576).toFixed(1)} MB`);
  return { taskId, reaped: true, skipped: null, meta };
}

/** A human-readable reason, or null when the task is genuinely idle. */
async function runInFlight(deps: ReaperDeps, taskId: string): Promise<string | null> {
  if (deps.isRunning?.(taskId)) return "this worker has a run in flight for the task";

  const busy = await deps.db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), inArray(runs.status, ["queued", "running"])))
    .limit(1);
  if (busy.length > 0) return "the task has a queued or running run";

  const [row] = await deps.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (row && row.status !== "idle") return `the task is ${row.status}`;
  return null;
}

/**
 * Where the store put it. `SnapshotStore` deliberately does not expose a path
 * -- an S3 implementation has none -- so the FS store's own accessor is used
 * when it is present, and the recorded value falls back to the store's naming
 * convention otherwise. It is a breadcrumb for a human, not an address the code
 * reads back.
 */
function storePathOf(store: SnapshotStore, taskId: string): string {
  const candidate = store as { pathFor?: (id: string) => string };
  return typeof candidate.pathFor === "function" ? candidate.pathFor(taskId) : `${taskId}.tar.zst`;
}
