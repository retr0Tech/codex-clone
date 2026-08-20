import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  MirrorError,
  MirrorManager,
  defaultCloneUrl,
  mirrorDirName,
  mirrorPathFor,
  mirrorsRoot,
} from "./mirrors.js";
import type { GitRunner } from "./mirrors.js";

/** Randomly generated per run; no real token exists anywhere in this repo. */
function fakeToken(): string {
  return `ghp_${randomBytes(20).toString("hex")}`;
}

interface Invocation {
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * A git that records what it was asked to do and creates the directory a real
 * `clone --mirror` would have created. No network, no git binary.
 */
function fakeGit(options: { fail?: string; delayMs?: number } = {}) {
  const calls: Invocation[] = [];
  const runner: GitRunner = async (args, opts) => {
    calls.push({ args, env: opts.env ?? {} });
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    if (options.fail) {
      throw Object.assign(new Error("git failed"), { stderr: options.fail });
    }
    const cloneIndex = args.indexOf("clone");
    if (cloneIndex >= 0) {
      const target = args[args.length - 1];
      if (target) {
        await mkdir(target, { recursive: true });
        await writeFile(join(target, "FETCH_HEAD"), "");
      }
    }
    return { stdout: "", stderr: "" };
  };
  return { runner, calls };
}

describe("mirror paths", () => {
  it("flattens owner/repo into one directory name", () => {
    assert.equal(mirrorDirName("retr0Tech", "codex-clone"), "retr0Tech__codex-clone.git");
    assert.equal(mirrorPathFor("/data", "acme", "app"), join("/data", "mirrors", "acme__app.git"));
    assert.equal(mirrorsRoot("/data"), join("/data", "mirrors"));
  });

  it("does not collide when a repo name contains an underscore", () => {
    // `a_b/c` and `a/b_c` must not land in the same directory.
    assert.notEqual(mirrorDirName("a_b", "c"), mirrorDirName("a", "b_c"));
  });

  it("defaults to the public https clone url", () => {
    assert.equal(defaultCloneUrl("acme", "app"), "https://github.com/acme/app.git");
  });
});

describe("MirrorManager", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "codex-mirrors-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("clones a missing mirror with --mirror", async () => {
    const git = fakeGit();
    const manager = new MirrorManager({ dataDir, git: git.runner });

    const info = await manager.ensureMirror({ owner: "acme", name: "app" });

    assert.equal(info.created, true);
    assert.equal(info.skipped, false);
    assert.equal(info.fullName, "acme/app");
    assert.equal(info.path, mirrorPathFor(dataDir, "acme", "app"));
    assert.equal(git.calls.length, 1);

    const args = git.calls[0]?.args ?? [];
    assert.ok(args.includes("clone"));
    // --mirror, not --bare: --bare configures no fetch refspec, so a later
    // `fetch --prune` would not keep refs in sync.
    assert.ok(args.includes("--mirror"));
    assert.equal(args[args.length - 1], info.path);
  });

  it("fetches --prune when the mirror already exists", async () => {
    const git = fakeGit();
    const manager = new MirrorManager({ dataDir, git: git.runner });

    await manager.ensureMirror({ owner: "acme", name: "app" });
    const second = await manager.refreshMirror({ owner: "acme", name: "app" });

    assert.equal(second.created, false);
    assert.equal(git.calls.length, 2);
    const args = git.calls[1]?.args ?? [];
    assert.ok(args.includes("fetch"));
    assert.ok(args.includes("--prune"));
    assert.deepEqual(args.slice(0, 2), ["-C", second.path]);
  });

  it("creates the mirrors root on demand", async () => {
    const git = fakeGit();
    await new MirrorManager({ dataDir, git: git.runner }).ensureMirror({ owner: "acme", name: "app" });
    assert.ok((await stat(mirrorsRoot(dataDir))).isDirectory());
  });

  it("reports existence without running git", async () => {
    const git = fakeGit();
    const manager = new MirrorManager({ dataDir, git: git.runner });

    assert.equal(await manager.exists("acme", "app"), false);
    await manager.ensureMirror({ owner: "acme", name: "app" });
    assert.equal(await manager.exists("acme", "app"), true);
  });

  it("skips the fetch while the mirror is still fresh", async () => {
    const git = fakeGit();
    const manager = new MirrorManager({ dataDir, git: git.runner });

    await manager.ensureMirror({ owner: "acme", name: "app" });
    const skipped = await manager.ensureMirror({ owner: "acme", name: "app" }, { staleAfterMs: 60_000 });

    assert.equal(skipped.skipped, true);
    assert.equal(git.calls.length, 1, "a fresh mirror must not trigger a second fetch");
  });

  it("fetches again once the mirror is stale", async () => {
    const git = fakeGit();
    // Clock injected rather than slept on: staleness is a decision about
    // elapsed time, and the test should not be one.
    let clock = Date.now();
    const manager = new MirrorManager({ dataDir, git: git.runner, now: () => new Date(clock) });

    await manager.ensureMirror({ owner: "acme", name: "app" });
    clock += 5 * 60_000;
    const refreshed = await manager.ensureMirror({ owner: "acme", name: "app" }, { staleAfterMs: 60_000 });

    assert.equal(refreshed.skipped, false);
    assert.equal(git.calls.length, 2);
  });
});

describe("MirrorManager credential handling", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "codex-mirrors-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("never puts the token in argv or in the remote url", async () => {
    const git = fakeGit();
    const token = fakeToken();
    await new MirrorManager({ dataDir, git: git.runner }).ensureMirror({ owner: "acme", name: "app", token });

    const call = git.calls[0];
    assert.ok(call);
    assert.ok(!call.args.some((arg) => arg.includes(token)), "token leaked into the git command line");
    assert.ok(call.args.includes(defaultCloneUrl("acme", "app")), "the remote url must be the plain one");
  });

  it("passes the token through the environment, via a credential helper", async () => {
    const git = fakeGit();
    const token = fakeToken();
    await new MirrorManager({ dataDir, git: git.runner }).ensureMirror({ owner: "acme", name: "app", token });

    const call = git.calls[0];
    assert.ok(call);
    assert.equal(call.env["CODEX_GH_TOKEN"], token);
    assert.equal(call.env["GIT_TERMINAL_PROMPT"], "0", "must never block on an interactive prompt");
    // An empty helper first, to reset osxkeychain and friends.
    assert.ok(call.args.includes("credential.helper="));
    assert.ok(call.args.some((arg) => arg.startsWith("credential.helper=!f()")));
  });

  it("sets no credential configuration for a public repo", async () => {
    const git = fakeGit();
    await new MirrorManager({ dataDir, git: git.runner }).ensureMirror({ owner: "acme", name: "app" });

    const call = git.calls[0];
    assert.ok(call);
    assert.ok(!call.args.some((arg) => arg.startsWith("credential.helper")));
    assert.equal(call.env["CODEX_GH_TOKEN"], undefined);
  });

  it("redacts the token out of a git failure", async () => {
    const token = fakeToken();
    const git = fakeGit({ fail: `fatal: could not read from https://x-access-token:${token}@github.com/acme/app.git` });
    const manager = new MirrorManager({ dataDir, git: git.runner });

    await assert.rejects(
      () => manager.ensureMirror({ owner: "acme", name: "app", token }),
      (error: unknown) => {
        assert.ok(error instanceof MirrorError);
        assert.ok(!(error as Error).message.includes(token), "token leaked into the error message");
        assert.match((error as Error).message, /\[REDACTED\]/);
        return true;
      },
    );
  });
});

describe("MirrorManager concurrency", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "codex-mirrors-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("coalesces concurrent refreshes of the same mirror into one git", async () => {
    // Two fetches racing into one bare repo is how you corrupt it.
    const git = fakeGit({ delayMs: 25 });
    const manager = new MirrorManager({ dataDir, git: git.runner });

    const results = await Promise.all([
      manager.ensureMirror({ owner: "acme", name: "app" }),
      manager.ensureMirror({ owner: "acme", name: "app" }),
      manager.ensureMirror({ owner: "acme", name: "app" }),
    ]);

    assert.equal(git.calls.length, 1);
    assert.equal(new Set(results.map((r) => r.path)).size, 1);
  });

  it("still allows different mirrors to run in parallel", async () => {
    const git = fakeGit({ delayMs: 10 });
    const manager = new MirrorManager({ dataDir, git: git.runner });

    await Promise.all([
      manager.ensureMirror({ owner: "acme", name: "app" }),
      manager.ensureMirror({ owner: "acme", name: "other" }),
    ]);

    assert.equal(git.calls.length, 2);
  });

  it("releases the in-process slot after a failure", async () => {
    const git = fakeGit({ fail: "fatal: boom" });
    const manager = new MirrorManager({ dataDir, git: git.runner });

    await assert.rejects(() => manager.ensureMirror({ owner: "acme", name: "app" }));
    // A failed refresh must not wedge the mirror for the rest of the process.
    await assert.rejects(() => manager.ensureMirror({ owner: "acme", name: "app" }));
    assert.equal(git.calls.length, 2);
  });

  it("waits behind another process's lock, then times out rather than racing", async () => {
    const git = fakeGit();
    const manager = new MirrorManager({ dataDir, git: git.runner, lockTimeoutMs: 200, staleLockMs: 60_000 });

    // Simulate the worker holding the lock while the web app asks.
    await mkdir(mirrorsRoot(dataDir), { recursive: true });
    await mkdir(`${mirrorPathFor(dataDir, "acme", "app")}.lock`);

    await assert.rejects(
      () => manager.ensureMirror({ owner: "acme", name: "app" }),
      (error: unknown) => {
        assert.ok(error instanceof MirrorError);
        assert.match((error as Error).message, /Timed out/);
        return true;
      },
    );
    assert.equal(git.calls.length, 0, "must not touch the repo while another process holds the lock");
  });

  it("breaks a stale lock left by a crashed process", async () => {
    const git = fakeGit();
    const manager = new MirrorManager({ dataDir, git: git.runner, lockTimeoutMs: 200, staleLockMs: 0 });

    await mkdir(mirrorsRoot(dataDir), { recursive: true });
    await mkdir(`${mirrorPathFor(dataDir, "acme", "app")}.lock`);

    // Otherwise one crash mid-fetch wedges the repository forever.
    const info = await manager.ensureMirror({ owner: "acme", name: "app" });
    assert.equal(info.created, true);
    assert.equal(git.calls.length, 1);
  });

  it("removes its lock when the fetch fails", async () => {
    const git = fakeGit({ fail: "fatal: boom" });
    const manager = new MirrorManager({ dataDir, git: git.runner });

    await assert.rejects(() => manager.ensureMirror({ owner: "acme", name: "app" }));
    await assert.rejects(
      () => stat(`${mirrorPathFor(dataDir, "acme", "app")}.lock`),
      "the lock must be released on the error path",
    );
  });
});
