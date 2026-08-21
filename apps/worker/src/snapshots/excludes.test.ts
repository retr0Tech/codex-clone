import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { git } from "../runner/git.js";
import { pruneExcluded } from "./excludes.js";

/**
 * What a cold snapshot leaves behind, and what it must never leave behind.
 *
 * Deliberately Docker-free: this is the half of the reap path that decides
 * whether a restored workspace is byte-equivalent, and it should be checkable
 * on a machine that cannot run a container.
 */

describe("pruneExcluded", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "codex-prune-"));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function fixture(name: string): Promise<string> {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async function file(dir: string, rel: string, body = "x"): Promise<void> {
    const path = join(dir, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
  }

  it("removes untracked build and dependency directories at any depth", async () => {
    const dir = await fixture("plain");
    await file(dir, "src/index.ts");
    await file(dir, "node_modules/left-pad/index.js");
    await file(dir, "packages/api/node_modules/dep/index.js");
    await file(dir, "packages/api/dist/bundle.js");
    await file(dir, ".venv/bin/python");
    await file(dir, "__pycache__/mod.pyc");

    const result = await pruneExcluded(dir);

    assert.equal(existsSync(join(dir, "src/index.ts")), true, "source is not a build artefact");
    for (const gone of ["node_modules", "packages/api/node_modules", "packages/api/dist", ".venv", "__pycache__"]) {
      assert.equal(existsSync(join(dir, gone)), false, `${gone} should have been pruned`);
    }
    assert.deepEqual(result.removed.sort(), [
      ".venv",
      "__pycache__",
      "node_modules",
      "packages/api/dist",
      "packages/api/node_modules",
    ]);
    assert.deepEqual(result.kept, []);
    assert.ok(result.bytesRemoved > 0);
  });

  it("leaves a file whose NAME collides with an excluded directory alone", async () => {
    const dir = await fixture("file-collision");
    await file(dir, "dist", "this is a file, not a build directory");

    const result = await pruneExcluded(dir);
    assert.equal(existsSync(join(dir, "dist")), true);
    assert.deepEqual(result.removed, []);
  });

  it("does not follow a symlink that happens to be called node_modules", async () => {
    const dir = await fixture("symlink");
    await file(dir, "real/pkg.js");
    await symlink(join(dir, "real"), join(dir, "node_modules"));

    const result = await pruneExcluded(dir);
    // The symlink travels as a symlink; what it points at is untouched.
    assert.equal(existsSync(join(dir, "real/pkg.js")), true);
    assert.deepEqual(result.removed, []);
  });

  it("never prunes anything inside .git, whatever it is called", async () => {
    const dir = await fixture("dot-git");
    await file(dir, ".git/lfs/cache/objects/aa");
    await file(dir, ".git/objects/pack/pack-1.pack");

    await pruneExcluded(dir);
    assert.equal(existsSync(join(dir, ".git/lfs/cache/objects/aa")), true, ".git IS the snapshot");
    assert.equal(existsSync(join(dir, ".git/objects/pack/pack-1.pack")), true);
  });

  /**
   * The rule that is not in SNAPSHOT_EXCLUDES, and the one that makes
   * "byte-equivalent for tracked content" a guarantee rather than a hope:
   * plenty of repositories commit a dist/, and dropping it would make the
   * restored workspace differ from the archived one.
   */
  it("keeps an excluded directory the repository actually tracks", async () => {
    const dir = await fixture("tracked-dist");
    await file(dir, "src/index.ts");
    await file(dir, "dist/committed.js", "checked in on purpose");
    await file(dir, "node_modules/dep/index.js");

    await git(["init", "--initial-branch=main", dir]);
    await git(["-c", `safe.directory=${dir}`, "-C", dir, "add", "src", "dist"]);

    const result = await pruneExcluded(dir);

    assert.equal(existsSync(join(dir, "dist/committed.js")), true, "git tracks this; it must survive the snapshot");
    assert.equal(existsSync(join(dir, "node_modules")), false, "nothing tracks node_modules");
    assert.deepEqual(result.kept, ["dist"]);
    assert.deepEqual(result.removed, ["node_modules"]);
  });

  it("prunes an untracked build directory even inside a git repository", async () => {
    const dir = await fixture("untracked-dist");
    await file(dir, "src/index.ts");
    await file(dir, "dist/generated.js");

    await git(["init", "--initial-branch=main", dir]);
    await git(["-c", `safe.directory=${dir}`, "-C", dir, "add", "src"]);

    const result = await pruneExcluded(dir);
    assert.equal(existsSync(join(dir, "dist")), false);
    assert.deepEqual(result.removed, ["dist"]);
  });

  it("is a no-op on a workspace with nothing to prune", async () => {
    const dir = await fixture("clean");
    await file(dir, "README.md");

    const result = await pruneExcluded(dir);
    assert.deepEqual(result, { removed: [], kept: [], bytesRemoved: 0 });
  });
});
