import { join } from "node:path";
import type Docker from "dockerode";
import { redact } from "@codex-clone/core";
import type { Database } from "@codex-clone/db";
import { GitHubClient, createOctokit, type PullRequestSummary } from "@codex-clone/github";
import { git } from "./git.js";
import { loadTaskContext } from "./run-state.js";
import { uploadDirectory, withWorkspaceCopy } from "./volume-io.js";

/**
 * Getting the agent's work onto GitHub.
 *
 * Every credentialed step happens HERE, in the worker, on the host (PLAN.md
 * §3.3). The container that produced this work never had a GitHub token, never
 * had a remote it could reach, and is usually already destroyed by the time
 * this runs. The agent's output is a working tree; turning that into a commit,
 * a branch and a pull request is the host's job entirely.
 *
 *   ws-<taskId> ──extract──▶ host copy ──add -A, commit──▶ push (PAT) ──▶ PR
 *        ▲                        │
 *        └──── .git written back ─┘
 *
 * The write-back is the part worth explaining. The commit is made in an
 * extracted copy, so without it the volume would never learn that the work was
 * committed -- and the NEXT push would build a second commit from the same base
 * and diverge from the branch already on GitHub. Copying `.git` back (and only
 * `.git`: a commit does not touch the working tree) keeps the volume the single
 * source of truth and keeps every later push a fast-forward.
 */

export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
  }
}

export interface PublishDeps {
  db: Database;
  docker: Docker;
  githubToken: () => Promise<string | null>;
  config: { image: string; dataDir: string };
  log?: (message: string) => void;
}

export interface PushResult {
  branch: string;
  /** Null when there was nothing to commit and nothing had been committed before. */
  commit: string | null;
  /** False when the branch was already up to date. */
  pushed: boolean;
  filesChanged: number;
  branchUrl: string;
  compareUrl: string;
  repoFullName: string;
  baseBranch: string;
}

export interface PublishResult extends PushResult {
  pullRequest: PullRequestSummary | null;
}

export interface PublishOptions {
  /** Also open a pull request once the branch is on GitHub. */
  openPullRequest?: boolean;
  title?: string;
  body?: string;
}

/**
 * Commits whatever is in the workspace, pushes the work branch, and optionally
 * opens a pull request.
 *
 * Refuses when the task has no workspace yet -- there is nothing to publish
 * before the first run has seeded one.
 */
export async function publishTask(
  deps: PublishDeps,
  taskId: string,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const task = await loadTaskContext(deps.db, taskId);
  if (!task) throw new PublishError(`no task ${taskId}`);
  if (!task.volumeName) {
    throw new PublishError("this task has no workspace yet; run it once before pushing");
  }
  if (!task.workBranch) {
    throw new PublishError("this task has no work branch yet; run it once before pushing");
  }

  const token = await deps.githubToken();
  if (!token) throw new PublishError("No GitHub token is configured. Add one on the Settings page.");

  const cloneUrl = `https://github.com/${task.repo.fullName}.git`;
  const branch = task.workBranch;
  const log = deps.log ?? (() => undefined);

  const pushed = await withWorkspaceCopy(
    deps.docker,
    task.volumeName,
    join(deps.config.dataDir, "publish"),
    { image: deps.config.image, taskId },
    async (dir): Promise<PushResult> => {
      const opts = { cwd: dir };
      await git(["config", "--local", "safe.directory", dir], opts).catch(() => undefined);
      await git(["config", "--local", "user.name", "codex-clone"], opts);
      await git(["config", "--local", "user.email", "codex-clone@localhost"], opts);

      // The agent may have committed through the shell tool, or may have left
      // everything in the working tree. Both end up as one commit here.
      await git(["add", "-A"], opts);
      const staged = (await git(["diff", "--cached", "--name-only"], opts)).trim();
      const filesChanged = staged === "" ? 0 : staged.split("\n").length;

      if (filesChanged > 0) {
        await git(["commit", "-m", commitMessage(task.title, filesChanged)], opts);
      }

      const head = (await git(["rev-parse", "HEAD"], opts)).trim();
      const alreadyPushed = head === task.baseSha && filesChanged === 0;
      if (alreadyPushed) {
        throw new PublishError("nothing to push: the workspace is identical to the base commit");
      }

      // The token is supplied per invocation through an env-reading credential
      // helper, so it lands neither in .git/config nor in the process argv.
      log(`[publish ${taskId.slice(0, 8)}] pushing ${branch}`);
      await git(["push", "--set-upstream", cloneUrl, `HEAD:refs/heads/${branch}`], { cwd: dir, token });

      if (filesChanged > 0) {
        // Only `.git`: the commit changed history, not the working tree. Keeps
        // the volume authoritative so the next push fast-forwards.
        await uploadDirectory(deps.docker, task.volumeName as string, join(dir, ".git"), {
          image: deps.config.image,
          taskId,
          targetPath: "/workspace/.git",
        });
      }

      return {
        branch,
        commit: head,
        pushed: true,
        filesChanged,
        repoFullName: task.repo.fullName,
        baseBranch: task.baseBranch,
        branchUrl: `https://github.com/${task.repo.fullName}/tree/${encodeURIComponent(branch)}`,
        compareUrl: `https://github.com/${task.repo.fullName}/compare/${encodeURIComponent(
          task.baseBranch,
        )}...${encodeURIComponent(branch)}?expand=1`,
      };
    },
  );

  if (!options.openPullRequest) return { ...pushed, pullRequest: null };

  const client = new GitHubClient(createOctokit(token));
  try {
    const pullRequest = await client.openPullRequest(task.repo.owner, task.repo.name, {
      title: options.title?.trim() || task.title,
      head: branch,
      base: task.baseBranch,
      body: options.body ?? pullRequestBody(task.title, task.baseSha, pushed.filesChanged),
    });
    log(`[publish ${taskId.slice(0, 8)}] pull request ${pullRequest.url}`);
    return { ...pushed, pullRequest };
  } catch (error) {
    // The branch IS pushed at this point. Losing that fact because the PR call
    // failed would send the user looking for work that is already on GitHub.
    throw new PublishError(
      `the branch was pushed, but opening the pull request failed: ${redact(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
  }
}

function commitMessage(title: string, filesChanged: number): string {
  const summary = title.length > 68 ? `${title.slice(0, 65)}...` : title;
  return `${summary}\n\n${filesChanged} file(s) changed by a codex-clone agent run.`;
}

function pullRequestBody(title: string, baseSha: string, filesChanged: number): string {
  return [
    title,
    "",
    `Produced by a codex-clone agent run in an isolated container, against \`${baseSha.slice(0, 12)}\`.`,
    `${filesChanged} file(s) changed. The diff was derived by the host with \`git diff\`, not reported by the agent.`,
  ].join("\n");
}
