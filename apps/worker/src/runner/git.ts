import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redact } from "@codex-clone/core";

const execFileAsync = promisify(execFile);

/**
 * Host-side git.
 *
 * PLAN.md §3.3: every git operation in this system runs on the host, and the
 * sandbox holds no GitHub credential at all. The agent cannot clone, fetch or
 * push -- the worker does it on the agent's behalf, which is why a
 * prompt-injected agent has nothing to exfiltrate.
 *
 * Every invocation is bounded. An unbounded `git` is a run that holds one of
 * three concurrency slots forever and is indistinguishable from one that is
 * working.
 */

/** Two minutes: long enough to clone a large repo from a LOCAL mirror. */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    detail: string,
  ) {
    // git echoes remote URLs -- which is where a PAT would be -- into its
    // errors, so this is redacted before it can reach a log or an event.
    super(`git ${args.join(" ")} failed: ${redact(detail)}`);
    this.name = "GitError";
  }
}

export interface GitOptions {
  cwd?: string;
  timeoutMs?: number;
  /** A PAT, supplied per invocation. Never written to .git/config or argv. */
  token?: string | undefined;
}

/**
 * Supplies the PAT through an env-reading credential helper, so the token
 * appears neither in `.git/config` nor in the command line `ps` would show.
 * The empty first value resets any system or global helper (osxkeychain).
 */
const CREDENTIAL_HELPER = '!f() { echo username=x-access-token; echo "password=$CODEX_GH_TOKEN"; }; f';
const CREDENTIAL_ARGS = ["-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`];

export async function git(args: string[], options: GitOptions = {}): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Never block on an interactive prompt: this runs headless, and a prompt
    // would look exactly like a hang.
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
  };
  if (options.token) env["CODEX_GH_TOKEN"] = options.token;

  try {
    const { stdout } = await execFileAsync("git", options.token ? [...CREDENTIAL_ARGS, ...args] : args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env,
      timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    throw new GitError(args, describe(err));
  }
}

function describe(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const e = err as { stderr?: string; message?: string; killed?: boolean; signal?: string };
    if (e.killed && e.signal) return `timed out (killed with ${e.signal})`;
    if (e.stderr && e.stderr.trim() !== "") return e.stderr.trim();
    if (e.message) return e.message;
  }
  return String(err);
}
