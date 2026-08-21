import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type Docker from "dockerode";
import type { MirrorManager } from "@codex-clone/github";
import { ensureVolume, volumeExists, VOLUME_KIND_WORKSPACE } from "@codex-clone/sandbox-docker";
import { git } from "./git.js";
import { uploadDirectory } from "./volume-io.js";

/**
 * Getting a repository into a task's workspace volume (PLAN.md §3.7).
 *
 *   github.com ──fetch──▶ ~/.codexclone/mirrors/<owner>__<repo>.git   (bare)
 *                              │ clone --local, checkout <baseSha>
 *                              ▼
 *                         host temp dir
 *                              │ tar, uid 10001
 *                              ▼
 *                     docker volume ws-<taskId>
 *
 * Every arrow is drawn by the host. The only credentialed hop is the first, and
 * it happens in this process: the container is handed a finished checkout with
 * no remote it can reach and no credential to reach it with.
 *
 * The middle hop exists because the host cannot write into a named volume
 * directly. It costs one copy of the tree per NEW task; follow-up turns reuse
 * the warm volume and skip all of this.
 */

export interface RepoRef {
  owner: string;
  name: string;
  cloneUrl: string;
}

export interface PrepareWorkspaceSpec {
  taskId: string;
  volumeName: string;
  repo: RepoRef;
  /** Pinned at task creation. Never taken from the client. */
  baseSha: string;
  /** Created here so the agent's edits are already on a pushable branch. */
  workBranch: string;
  /** PAT for the mirror fetch only. Never leaves this process. */
  token?: string | undefined;
}

export interface PrepareWorkspaceOptions {
  docker: Docker;
  mirrors: MirrorManager;
  /** Agent image, reused as the helper for the archive endpoint. */
  image: string;
  /** Host scratch space; under CODEX_DATA_DIR, not /tmp. */
  scratchRoot: string;
  /** A mirror fetched more recently than this is good enough. */
  mirrorStaleAfterMs?: number;
  /**
   * Wake-after-reap (PLAN.md §3.1). Called when the task has no hot volume;
   * returns true if it restored one from the cold snapshot store, false if
   * there was nothing to restore and this is genuinely a fresh workspace.
   *
   * Injected rather than imported so the seeding path has no opinion about
   * where cold storage is -- and so a worker configured without a snapshot
   * store still clones from the mirror instead of failing.
   */
  restoreFromCold?: (ctx: { taskId: string; volumeName: string }) => Promise<boolean>;
  onLog?: (line: string) => void;
}

export interface PreparedWorkspace {
  /** False when the volume was already seeded and this was a warm reuse. */
  seeded: boolean;
  /** True when the workspace came back from the cold tier rather than a clone. */
  restoredFromCold: boolean;
  mirrorPath: string;
  mirrorFetchedAt: Date;
}

/** One minute. A burst of tasks on one repo should not be a burst of fetches. */
export const DEFAULT_MIRROR_STALE_MS = 60_000;

/**
 * Ensures `ws-<taskId>` holds a checkout of `baseSha` on `workBranch`.
 *
 * Idempotent: `alreadySeeded` short-circuits the copy for a follow-up turn, so
 * the second turn of a task starts in whatever state the first one left behind
 * -- which is the entire point of the volume outliving its container.
 */
export async function prepareWorkspace(
  spec: PrepareWorkspaceSpec,
  options: PrepareWorkspaceOptions,
  alreadySeeded: boolean,
): Promise<PreparedWorkspace> {
  const log = options.onLog ?? (() => undefined);

  // The mirror is refreshed even on a warm workspace: a follow-up turn may want
  // objects that landed upstream since the task was created, and a fetch into a
  // bare repo on local disk is cheap.
  log(`fetching ${spec.repo.owner}/${spec.repo.name} into the host mirror\n`);
  const mirror = await options.mirrors.ensureMirror(
    {
      owner: spec.repo.owner,
      name: spec.repo.name,
      cloneUrl: spec.repo.cloneUrl,
      token: spec.token,
    },
    { staleAfterMs: options.mirrorStaleAfterMs ?? DEFAULT_MIRROR_STALE_MS },
  );
  log(
    mirror.skipped
      ? `mirror is fresh (${mirror.path})\n`
      : `${mirror.created ? "cloned" : "refreshed"} mirror at ${mirror.path}\n`,
  );

  await ensureVolume(options.docker, spec.volumeName, {
    kind: VOLUME_KIND_WORKSPACE,
    taskId: spec.taskId,
  });

  if (alreadySeeded && (await volumeExists(options.docker, spec.volumeName))) {
    log(`reusing the warm workspace in ${spec.volumeName}\n`);
    return { seeded: false, restoredFromCold: false, mirrorPath: mirror.path, mirrorFetchedAt: mirror.fetchedAt };
  }

  /**
   * Wake after reap (PLAN.md §3.1). The reaper cleared `volume_name` on its way
   * out, so this looks exactly like a new task -- and it must not be treated as
   * one, or the agent's uncommitted work would be replaced by a clean checkout
   * of the base commit. The cold snapshot is asked first, and only a task that
   * has none falls through to the clone below.
   *
   * The repo setup script re-runs regardless: it runs on every container start,
   * which is what makes it safe to leave node_modules out of the snapshot.
   */
  if (!alreadySeeded && options.restoreFromCold) {
    log(`no hot workspace for this task; checking the cold snapshot store\n`);
    if (await options.restoreFromCold({ taskId: spec.taskId, volumeName: spec.volumeName })) {
      return { seeded: true, restoredFromCold: true, mirrorPath: mirror.path, mirrorFetchedAt: mirror.fetchedAt };
    }
    log(`no cold snapshot either; this workspace is new\n`);
  }

  await mkdir(options.scratchRoot, { recursive: true });
  const staging = await mkdtemp(join(options.scratchRoot, `seed-${spec.taskId}-`));
  try {
    log(`cloning ${spec.baseSha.slice(0, 12)} from the local mirror\n`);
    // --local hardlinks objects out of the mirror instead of copying or talking
    // to a network. --no-checkout so the working tree is written exactly once,
    // at the pinned SHA, rather than at the mirror's HEAD first.
    await git(["clone", "--local", "--no-checkout", mirror.path, staging]);
    // The remote is set to the real URL so the branch has somewhere to go when
    // the host pushes it. No credential is stored in it; the PAT is supplied
    // per invocation through an env-reading credential helper.
    await git(["remote", "set-url", "origin", spec.repo.cloneUrl], { cwd: staging });
    await git(["checkout", "-B", spec.workBranch, spec.baseSha], { cwd: staging });
    // The agent may commit through the shell tool; give it an identity so that
    // does not fail with "please tell me who you are".
    await git(["config", "user.name", "codex-clone"], { cwd: staging });
    await git(["config", "user.email", "codex-clone@localhost"], { cwd: staging });

    log(`seeding ${spec.volumeName} on ${spec.workBranch}\n`);
    await uploadDirectory(options.docker, spec.volumeName, staging, {
      image: options.image,
      taskId: spec.taskId,
    });
    log(`workspace ready\n`);

    return { seeded: true, restoredFromCold: false, mirrorPath: mirror.path, mirrorFetchedAt: mirror.fetchedAt };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * `codex/<slug>-<runSuffix>`.
 *
 * Namespaced under `codex/` so a glance at `git branch -r` says which branches
 * this tool created, and suffixed so two tasks with the same prompt on the same
 * repo cannot collide.
 */
export function workBranchName(title: string, taskId: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "task";
  return `codex/${slug}-${taskId.slice(-6)}`;
}
