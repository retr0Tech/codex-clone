/**
 * Host-side bare mirrors (PLAN.md §3.7).
 *
 *   ~/.codexclone/mirrors/<owner>__<repo>.git   bare, refreshed on demand
 *        │ clone --reference / clone from local path
 *        ▼
 *   docker volume ws-<taskId>
 *
 * A task workspace is cloned from local disk rather than from github.com, so
 * creating the tenth task on a repo costs a `git fetch` of whatever changed
 * rather than a full network clone. It also means the sandbox needs no network
 * access to GitHub at all, which is what lets it hold no credential.
 *
 * Two things this module is careful about:
 *
 *   - **The token never lands on disk.** The remote URL stored in the mirror's
 *     config is the plain https one; credentials are supplied per invocation
 *     through a `credential.helper` that reads an environment variable, so
 *     neither `.git/config` nor the process argv ever contains the PAT.
 *
 *   - **Concurrent refresh of the same mirror is impossible.** Git will
 *     happily corrupt a repository if two `fetch`es race into it. There is an
 *     in-process promise map for the common case (the worker fires three tasks
 *     on one repo at once) and a directory lock for the cross-process case
 *     (the web app and the worker both want the same mirror).
 */

import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { redact, registerSecret } from "@codex-clone/core";

const execFileAsync = promisify(execFile);

export interface GitRunner {
  (args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }>;
}

export interface MirrorSpec {
  owner: string;
  name: string;
  /** Plain https clone URL. Defaults to github.com/<owner>/<name>.git. */
  cloneUrl?: string;
  /** PAT used for this invocation only. Omit for a public repo. */
  token?: string | undefined;
}

export interface MirrorInfo {
  owner: string;
  name: string;
  fullName: string;
  /** Absolute path of the bare repository. */
  path: string;
  cloneUrl: string;
  /** True when this call created the mirror rather than refreshing it. */
  created: boolean;
  /** True when the fetch was skipped because the mirror was still fresh. */
  skipped: boolean;
  fetchedAt: Date;
}

export interface MirrorManagerOptions {
  /** CODEX_DATA_DIR. Mirrors live in `<dataDir>/mirrors`. */
  dataDir: string;
  git?: GitRunner;
  /** Give up waiting for another process's lock after this long. */
  lockTimeoutMs?: number;
  /** A lock directory older than this is assumed to be from a crashed process. */
  staleLockMs?: number;
  now?: () => Date;
}

/**
 * `owner__repo.git`. A double underscore rather than a slash because this is
 * one flat directory, and rather than a single underscore because repository
 * names may legally contain one and we do not want `a_b/c` and `a/b_c` to
 * collide.
 */
export function mirrorDirName(owner: string, name: string): string {
  return `${owner}__${name}.git`;
}

export function mirrorsRoot(dataDir: string): string {
  return join(dataDir, "mirrors");
}

export function mirrorPathFor(dataDir: string, owner: string, name: string): string {
  return join(mirrorsRoot(dataDir), mirrorDirName(owner, name));
}

export function defaultCloneUrl(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}.git`;
}

/**
 * Supplies the PAT to git without writing it anywhere durable.
 *
 * The helper script itself contains no secret -- it echoes an environment
 * variable -- so the token appears neither in `.git/config` nor in the
 * command line that `ps` would show.
 */
const CREDENTIAL_HELPER = '!f() { echo username=x-access-token; echo "password=$CODEX_GH_TOKEN"; }; f';

/** The empty first value resets any system/global helper (e.g. osxkeychain). */
const CREDENTIAL_ARGS = ["-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`];

export class MirrorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MirrorError";
  }
}

export class MirrorManager {
  readonly #dataDir: string;
  readonly #git: GitRunner;
  readonly #lockTimeoutMs: number;
  readonly #staleLockMs: number;
  readonly #now: () => Date;
  /** In-process coalescing: concurrent callers share one refresh. */
  readonly #inFlight = new Map<string, Promise<MirrorInfo>>();

  constructor(options: MirrorManagerOptions) {
    this.#dataDir = options.dataDir;
    this.#git = options.git ?? defaultGitRunner;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 60_000;
    this.#staleLockMs = options.staleLockMs ?? 10 * 60_000;
    this.#now = options.now ?? (() => new Date());
  }

  pathFor(owner: string, name: string): string {
    return mirrorPathFor(this.#dataDir, owner, name);
  }

  async exists(owner: string, name: string): Promise<boolean> {
    return isDirectory(this.pathFor(owner, name));
  }

  /**
   * Clones the mirror if it is missing, then refreshes it.
   *
   * `staleAfterMs` lets a caller say "a mirror fetched in the last N ms is
   * good enough", which is what stops a burst of tasks on one repo from
   * issuing a burst of fetches.
   */
  async ensureMirror(spec: MirrorSpec, opts: { staleAfterMs?: number } = {}): Promise<MirrorInfo> {
    const path = this.pathFor(spec.owner, spec.name);

    // Same mirror already being worked on in this process: join that, do not
    // start a second git.
    const pending = this.#inFlight.get(path);
    if (pending) return pending;

    const work = this.#ensureUnlocked(spec, path, opts.staleAfterMs).finally(() => {
      this.#inFlight.delete(path);
    });
    this.#inFlight.set(path, work);
    return work;
  }

  /** Refreshes an existing mirror, or creates it. Always fetches. */
  async refreshMirror(spec: MirrorSpec): Promise<MirrorInfo> {
    return this.ensureMirror(spec, { staleAfterMs: 0 });
  }

  async #ensureUnlocked(spec: MirrorSpec, path: string, staleAfterMs: number | undefined): Promise<MirrorInfo> {
    if (spec.token) registerSecret(spec.token);
    const cloneUrl = spec.cloneUrl ?? defaultCloneUrl(spec.owner, spec.name);
    await mkdir(mirrorsRoot(this.#dataDir), { recursive: true });

    const release = await this.#acquireLock(path);
    try {
      const existed = await isDirectory(path);

      if (existed && staleAfterMs !== undefined && staleAfterMs > 0) {
        const age = await mirrorAgeMs(path, this.#now());
        if (age !== null && age < staleAfterMs) {
          return this.#info(spec, path, cloneUrl, false, true);
        }
      }

      if (!existed) {
        // --mirror rather than --bare: it configures the refspec so that a
        // later `fetch --prune` actually keeps every ref in sync, which is the
        // entire job of this directory.
        await this.#run(["clone", "--mirror", cloneUrl, path], spec.token);
      } else {
        await this.#run(["-C", path, "fetch", "--prune", "--quiet", "origin"], spec.token);
      }

      return this.#info(spec, path, cloneUrl, !existed, false);
    } finally {
      await release();
    }
  }

  #info(spec: MirrorSpec, path: string, cloneUrl: string, created: boolean, skipped: boolean): MirrorInfo {
    return {
      owner: spec.owner,
      name: spec.name,
      fullName: `${spec.owner}/${spec.name}`,
      path,
      cloneUrl,
      created,
      skipped,
      fetchedAt: this.#now(),
    };
  }

  async #run(args: string[], token: string | undefined): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Never block on an interactive credential prompt: this runs headless.
      GIT_TERMINAL_PROMPT: "0",
    };
    const fullArgs = token ? [...CREDENTIAL_ARGS, ...args] : args;
    if (token) env["CODEX_GH_TOKEN"] = token;

    try {
      const { stdout } = await this.#git(fullArgs, { env });
      return stdout;
    } catch (error) {
      // git echoes the remote URL into its errors. Redact before this reaches
      // a log, an event payload or an HTTP response.
      throw new MirrorError(redact(errorText(error)));
    }
  }

  /**
   * Cross-process lock.
   *
   * `mkdir` is atomic on every filesystem we care about, so the directory's
   * existence is the lock. A lock older than `staleLockMs` is assumed to
   * belong to a process that died mid-fetch and is broken rather than waited
   * on -- otherwise one crash wedges the repo forever.
   */
  async #acquireLock(path: string): Promise<() => Promise<void>> {
    const lockPath = `${path}.lock`;
    const deadline = Date.now() + this.#lockTimeoutMs;

    for (;;) {
      try {
        await mkdir(lockPath);
        return async () => {
          await rm(lockPath, { recursive: true, force: true });
        };
      } catch (error) {
        if (!isEexist(error)) throw error;

        const age = await pathAgeMs(lockPath);
        if (age !== null && age > this.#staleLockMs) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
        if (Date.now() > deadline) {
          throw new MirrorError(
            `Timed out after ${this.#lockTimeoutMs}ms waiting for another process to finish refreshing ${path}.`,
          );
        }
        await sleep(100);
      }
    }
  }
}

const defaultGitRunner: GitRunner = async (args, options) =>
  execFileAsync("git", args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    maxBuffer: 32 * 1024 * 1024,
  });

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pathAgeMs(path: string): Promise<number | null> {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/** Freshness is the mtime of FETCH_HEAD, which git touches on every fetch. */
async function mirrorAgeMs(path: string, now: Date): Promise<number | null> {
  for (const candidate of ["FETCH_HEAD", "packed-refs", "HEAD"]) {
    try {
      return now.getTime() - (await stat(join(path, candidate))).mtimeMs;
    } catch {
      continue;
    }
  }
  return null;
}

function isEexist(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EEXIST";
}

function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const e = error as { stderr?: string; message?: string };
    if (e.stderr && e.stderr.trim() !== "") return e.stderr.trim();
    if (e.message) return e.message;
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
