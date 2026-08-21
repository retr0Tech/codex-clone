import { join } from "node:path";
import type Docker from "dockerode";
import type { EventPayloadMap } from "@codex-clone/core";
import { git } from "./git.js";
import { mergeFileStats, parseNameStatus, parseNumstat, truncatePatch } from "./diff-parse.js";
import { withWorkspaceCopy } from "./volume-io.js";

/**
 * The diff is DERIVED, never reported (PLAN.md §3.8).
 *
 * The agent is asked what to change; it is never asked what changed. After each
 * turn the host takes the workspace as it actually is and runs `git diff`
 * against the SHA pinned at task creation. So the diff view shows reality, and
 * an agent that hallucinates a successful edit is contradicted by its own
 * transcript rather than believed by it.
 *
 * Two details that are easy to get wrong and would quietly show the wrong thing:
 *
 *  - **Untracked files count.** The agent's first act on a new file leaves it
 *    untracked, and a plain `git diff <baseSha>` shows nothing at all for it.
 *    Everything is staged in the throwaway copy first, so `--cached` sees new
 *    files, edits, deletions and anything the agent committed itself, all in
 *    one comparison against the pin.
 *
 *  - **The copy is thrown away.** Staging mutates the index, so it happens in
 *    an extracted copy of the volume rather than in the volume. The workspace
 *    the agent is using is never touched by the act of looking at it.
 */

export interface DeriveDiffOptions {
  docker: Docker;
  volumeName: string;
  baseSha: string;
  image: string;
  dataDir: string;
  taskId: string;
  timeoutMs?: number;
}

/** Bounded: a diff that will not finish must fail the turn, not stall the run. */
export const DEFAULT_DIFF_TIMEOUT_MS = 3 * 60 * 1000;

export async function deriveDiff(options: DeriveDiffOptions): Promise<EventPayloadMap["diff"]> {
  return withWorkspaceCopy(
    options.docker,
    options.volumeName,
    join(options.dataDir, "diffs"),
    { image: options.image, taskId: options.taskId, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) },
    async (dir) => {
      const opts = { cwd: dir, timeoutMs: options.timeoutMs ?? DEFAULT_DIFF_TIMEOUT_MS };

      // The volume was written by the host and is read here by a different uid
      // on the way out; git refuses to operate across that boundary until the
      // directory is marked safe. Scoped to this invocation, not written to a
      // global config.
      await git(["config", "--local", "safe.directory", dir], opts).catch(() => undefined);
      await git(["config", "--local", "user.name", "codex-clone"], opts);
      await git(["config", "--local", "user.email", "codex-clone@localhost"], opts);

      // Everything the agent did, however it did it: edits, new files,
      // deletions, and any commits of its own.
      await git(["add", "-A"], opts);

      const [nameStatus, numstat, patch] = await Promise.all([
        git(["diff", "--cached", "--name-status", "-z", "-M", options.baseSha], opts),
        git(["diff", "--cached", "--numstat", "-z", "-M", options.baseSha], opts),
        git(["diff", "--cached", "-M", options.baseSha], opts),
      ]);

      const files = mergeFileStats(parseNameStatus(nameStatus), parseNumstat(numstat));
      const clipped = truncatePatch(patch);

      return {
        baseSha: options.baseSha,
        files,
        patch: clipped.patch,
        truncated: clipped.truncated,
      };
    },
  );
}

/**
 * Tools that can change the workspace.
 *
 * `read_file` and `grep` cannot, so a turn that only read things does not pay
 * for an extraction. `shell` can do anything, so it always counts.
 */
const MUTATING_TOOLS = new Set(["apply_patch", "shell"]);

/**
 * Decides when a diff is worth deriving.
 *
 * "After each turn" needs a definition, and the event stream gives an exact
 * one. Within a turn the agent emits its tool calls and results back to back;
 * the turn ENDS at the first thing that is not a tool event -- the next turn's
 * reasoning or message, or the run's finalizing phase. Marking the workspace
 * dirty on a mutating result and flushing at that boundary therefore produces
 * exactly one diff per turn that changed something, and none at all for a turn
 * that only looked around.
 */
export class DiffTrigger {
  #dirty = false;

  get dirty(): boolean {
    return this.#dirty;
  }

  /** Call for every ingested agent event, BEFORE it is persisted. */
  shouldDeriveBefore(type: string, payload: unknown): boolean {
    if (type === "tool_result") {
      const result = payload as { tool?: string; ok?: boolean };
      // A failed tool wrote nothing worth showing -- and `apply_patch` is
      // atomic, so a failure leaves the workspace exactly as it was.
      if (result.ok === true && result.tool !== undefined && MUTATING_TOOLS.has(result.tool)) {
        this.#dirty = true;
      }
      return false;
    }
    if (type === "tool_call") return false;
    // A non-tool event: the turn is over.
    return this.#dirty;
  }

  markDerived(): void {
    this.#dirty = false;
  }
}
