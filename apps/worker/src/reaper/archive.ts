import { join } from "node:path";
import { eq } from "drizzle-orm";
import { redact } from "@codex-clone/core";
import { tasks } from "@codex-clone/db";
import type { MirrorManager } from "@codex-clone/github";
import { workspaceVolumeName } from "@codex-clone/sandbox-docker";
import { git } from "../runner/git.js";
import { loadTaskContext } from "../runner/run-state.js";
import { withWorkspaceCopy } from "../runner/volume-io.js";
import { replaceVolumeContents, restoreWorkspace } from "../snapshots/archive.js";
import { readSnapshot } from "../snapshots/record.js";
import { ReapBusyError, reapTask, type ReaperDeps } from "./reaper.js";

/**
 * Archive, restore, and the one thing restore deliberately does NOT do.
 *
 * PLAN.md §3.10: archive is a status change, not a deletion. The event log is
 * retained in full and the cold snapshot is kept, so the transcript of an
 * archived task reads exactly as it did before -- and restoring recreates the
 * workspace **as it was**, on the commit it was pinned to, with the agent's
 * uncommitted edits still in the working tree.
 *
 * It does not rebase. A base branch that moved is a fact the user may want and
 * may not, and silently replaying their work onto a commit they have not seen
 * is the kind of helpfulness that loses work. `rebaseOntoBase` is the explicit
 * alternative, and it is a button, not a side effect.
 *
 * Restore is LAZY: unarchiving flips the status, and the workspace comes back
 * from the cold tier on the next turn through the ordinary wake path. That is
 * deliberate. Wake-after-reap is the code path PLAN.md §7 calls out as the one
 * that rots, so unarchive uses it rather than a second, better-exercised copy
 * of the same logic.
 */

export interface ArchiveDeps extends ReaperDeps {
  mirrors: MirrorManager;
  /** The PAT, for the mirror fetch a rebase needs. Never leaves this process. */
  githubToken: () => Promise<string | null>;
  /** Injectable so the integration suite can point at a bare repo on disk. */
  cloneUrl?: (repo: { owner: string; name: string; fullName: string }) => string;
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

export interface ArchiveResult {
  taskId: string;
  status: "archived";
  archivedAt: string;
  /** True when this call wrote a fresh cold snapshot. */
  snapshotted: boolean;
  sizeBytes: number | null;
}

/**
 * Archives a task: cold snapshot, drop the hot volume, flip the status.
 *
 * The snapshot happens FIRST and the status write rides in the same conditional
 * update that clears `volume_name`, so a task is never left marked archived
 * with a workspace that was not preserved.
 */
export async function archiveTask(deps: ArchiveDeps, taskId: string): Promise<ArchiveResult> {
  const [task] = await deps.db
    .select({ status: tasks.status, archivedAt: tasks.archivedAt })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!task) throw new ArchiveError(`no task ${taskId}`);

  if (task.status === "archived") {
    // Idempotent: two clicks on Archive is not an error.
    const existing = await readSnapshot(deps.db, taskId);
    return {
      taskId,
      status: "archived",
      archivedAt: (task.archivedAt ?? new Date()).toISOString(),
      snapshotted: false,
      sizeBytes: existing?.sizeBytes ?? null,
    };
  }

  const archivedAt = new Date();
  const outcome = await reapTask(deps, taskId, {
    trigger: "archive",
    // The whole point of the button is "now", not "in fifteen minutes".
    ignoreIdleTime: true,
    alsoSet: { status: "archived", archivedAt },
  });

  if (!outcome.reaped && outcome.meta === null) {
    // Either there was no hot workspace (status was still written) or the task
    // became busy mid-export (nothing was written). Distinguish by re-reading.
    const [after] = await deps.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (after?.status !== "archived") {
      throw new ReapBusyError(outcome.skipped ?? "the task could not be archived");
    }
  }

  return {
    taskId,
    status: "archived",
    archivedAt: archivedAt.toISOString(),
    snapshotted: outcome.meta !== null,
    sizeBytes: outcome.meta?.sizeBytes ?? null,
  };
}

export interface UnarchiveResult {
  taskId: string;
  status: "idle";
  /** Whether the next turn will restore from cold or re-clone from the mirror. */
  hasSnapshot: boolean;
  snapshotTakenAt: string | null;
}

/**
 * Returns a task to the sidebar. The workspace comes back on the next turn.
 */
export async function unarchiveTask(deps: ArchiveDeps, taskId: string): Promise<UnarchiveResult> {
  const [task] = await deps.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) throw new ArchiveError(`no task ${taskId}`);

  const meta = await deps.store.head(taskId);

  if (task.status === "archived") {
    await deps.db
      .update(tasks)
      // `lastActivityAt` moves so the restored task sorts where the user just
      // put it, at the top of the list, rather than back where it was buried.
      // It also resets the idle clock, so the reaper does not immediately
      // re-archive a task somebody just asked for.
      .set({ status: "idle", archivedAt: null, lastActivityAt: new Date() })
      .where(eq(tasks.id, taskId));
  }

  return {
    taskId,
    status: "idle",
    hasSnapshot: meta !== null,
    snapshotTakenAt: meta?.createdAt ?? null,
  };
}

export interface RebaseResult {
  taskId: string;
  branch: string;
  baseBranch: string;
  previousBaseSha: string;
  baseSha: string;
  /** False when the base branch had not moved and nothing was replayed. */
  rebased: boolean;
}

/**
 * The explicit "rebase onto latest &lt;branch&gt;" action (PLAN.md §3.10).
 *
 * Runs entirely on the host, in an extracted copy, exactly like the push path:
 * the container that produced this work never had a remote it could reach.
 *
 *   ws-<taskId> ──extract──▶ host copy ──fetch mirror, rebase──▶ replace volume
 *
 * `tasks.base_sha` moves with it. Every diff in this system is derived against
 * that pin, so leaving it behind would make the next diff attribute every
 * upstream commit to the agent -- which is the failure the derived diff exists
 * to prevent.
 *
 * A conflict aborts the rebase and leaves the workspace untouched. Resolving
 * one is a job for the agent, in a turn, with a transcript -- not for a button
 * that has no way to show its work.
 */
export async function rebaseOntoBase(deps: ArchiveDeps, taskId: string): Promise<RebaseResult> {
  const task = await loadTaskContext(deps.db, taskId);
  if (!task) throw new ArchiveError(`no task ${taskId}`);
  if (!task.workBranch) throw new ArchiveError("this task has no work branch yet; run it once before rebasing");

  const [row] = await deps.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (row?.status === "archived") throw new ArchiveError("restore this task before rebasing it");

  const busy = deps.isRunning?.(taskId) === true || row?.status !== "idle";
  if (busy) throw new ReapBusyError("this task has a run in flight; wait for it to finish");

  // Wake it if it is cold. A rebase on an archived-and-restored task is one of
  // the two reasons the cold path exists at all.
  const volumeName = await ensureHotWorkspace(deps, taskId);

  const token = await deps.githubToken();
  const mirror = await deps.mirrors.ensureMirror(
    {
      owner: task.repo.owner,
      name: task.repo.name,
      cloneUrl: (deps.cloneUrl ?? defaultCloneUrl)(task.repo),
      ...(token === null ? {} : { token }),
    },
    // Zero: the user pressed a button that says "latest".
    { staleAfterMs: 0 },
  );

  const target = (await git(["--git-dir", mirror.path, "rev-parse", `refs/heads/${task.baseBranch}`])).trim();
  if (target === task.baseSha) {
    return {
      taskId,
      branch: task.workBranch,
      baseBranch: task.baseBranch,
      previousBaseSha: task.baseSha,
      baseSha: task.baseSha,
      rebased: false,
    };
  }

  await withWorkspaceCopy(
    deps.docker,
    volumeName,
    join(deps.config.dataDir, "rebase"),
    { image: deps.config.image, taskId },
    async (dir) => {
      const opts = { cwd: dir };
      await git(["config", "--local", "safe.directory", dir], opts).catch(() => undefined);
      await git(["config", "--local", "user.name", "codex-clone"], opts);
      await git(["config", "--local", "user.email", "codex-clone@localhost"], opts);

      // Uncommitted work is real work. Commit it first so the rebase can carry
      // it, rather than refusing with "cannot rebase: you have unstaged
      // changes" or, worse, dropping it.
      await git(["add", "-A"], opts);
      const staged = (await git(["diff", "--cached", "--name-only"], opts)).trim();
      if (staged !== "") {
        await git(["commit", "-m", "codex-clone: work in progress before rebase"], opts);
      }

      // From the LOCAL mirror: no network, no credential, and the objects are
      // already on this disk.
      await git(["fetch", "--no-tags", mirror.path, `${task.baseBranch}:refs/codex/rebase-target`], opts);
      try {
        await git(["rebase", "refs/codex/rebase-target"], opts);
      } catch (error) {
        await git(["rebase", "--abort"], opts).catch(() => undefined);
        throw new ArchiveError(
          `the rebase onto ${task.baseBranch} hit a conflict and was aborted; the workspace is unchanged. ` +
            `Ask the agent to resolve it in a follow-up turn. (${redact(error instanceof Error ? error.message : String(error))})`,
        );
      }
      await git(["update-ref", "-d", "refs/codex/rebase-target"], opts).catch(() => undefined);

      // Wholesale replacement: a rebase changes both the working tree and
      // `.git`, and it can delete files, which a tar extraction over the old
      // volume would not.
      await replaceVolumeContents({
        docker: deps.docker,
        volumeName,
        taskId,
        image: deps.config.image,
        sourceDir: dir,
      });
    },
  );

  await deps.db.update(tasks).set({ baseSha: target, lastActivityAt: new Date() }).where(eq(tasks.id, taskId));

  return {
    taskId,
    branch: task.workBranch,
    baseBranch: task.baseBranch,
    previousBaseSha: task.baseSha,
    baseSha: target,
    rebased: true,
  };
}

/**
 * Makes sure the task has a live workspace volume, restoring from the cold tier
 * if the reaper has been through. Returns the volume name.
 */
async function ensureHotWorkspace(deps: ArchiveDeps, taskId: string): Promise<string> {
  const [task] = await deps.db.select({ volumeName: tasks.volumeName }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (task?.volumeName) return task.volumeName;

  const volumeName = workspaceVolumeName(taskId);
  const restored = await restoreWorkspace({
    docker: deps.docker,
    store: deps.store,
    taskId,
    volumeName,
    image: deps.config.image,
    scratchRoot: join(deps.config.dataDir, "snapshot-staging"),
    ...(deps.config.snapshotTimeoutMs === undefined ? {} : { timeoutMs: deps.config.snapshotTimeoutMs }),
    onLog: (line) => deps.log?.(`[wake ${taskId.slice(0, 8)}] ${line.trimEnd()}`),
  });
  if (!restored) {
    throw new ArchiveError("this task has no workspace and no cold snapshot; run it once first");
  }

  await deps.db.update(tasks).set({ volumeName }).where(eq(tasks.id, taskId));
  return volumeName;
}

function defaultCloneUrl(repo: { fullName: string }): string {
  return `https://github.com/${repo.fullName}.git`;
}
