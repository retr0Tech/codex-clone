import type { Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { SNAPSHOT_EXCLUDES } from "@codex-clone/core";
import { git } from "../runner/git.js";

/**
 * Applying `SNAPSHOT_EXCLUDES` to an extracted workspace.
 *
 * This is what keeps a cold snapshot megabytes rather than gigabytes: the
 * excluded directories are rebuilt by re-running the repo setup script on wake,
 * so carrying them through the cold tier buys nothing (PLAN.md §3.2).
 *
 * Done by pruning the extracted tree rather than by handing patterns to `tar`,
 * because `--exclude` means subtly different things to GNU tar and to the bsdtar
 * macOS ships -- non-anchored suffix matching in one, plain fnmatch in the
 * other, and neither reliably drops the CONTENTS of a matched directory. A
 * pruned directory is unambiguous, and it is testable without Docker, which is
 * the more valuable property for a path that only runs on wake-after-reap.
 *
 * The one rule that is not in the constant: **a directory git tracks is never
 * pruned.** Plenty of repositories commit a `dist/` or a `build/`, and dropping
 * those would make a restored workspace differ from the one that was archived
 * -- the exact guarantee milestone 8 exists to provide. `git ls-files` decides,
 * so the rule is the repository's own answer rather than ours.
 */

const EXCLUDED_NAMES: ReadonlySet<string> = new Set<string>(SNAPSHOT_EXCLUDES);

/** Deep enough for any real repository; a guard against a symlink-free cycle. */
const MAX_DEPTH = 64;

export interface PruneResult {
  /** Directories removed from the archive, repo-relative. */
  removed: string[];
  /** Excluded names kept anyway, because the repository tracks content there. */
  kept: string[];
  bytesRemoved: number;
}

/**
 * Removes every excluded directory from `root` that git does not track.
 *
 * `root` is a throwaway extraction of the workspace volume, never the volume
 * itself -- nothing here can delete a file the agent is still working on.
 */
export async function pruneExcluded(root: string): Promise<PruneResult> {
  const tracked = await trackedDirectories(root);
  const result: PruneResult = { removed: [], kept: [], bytesRemoved: 0 };
  await walk(root, "", 0, tracked, result);
  return result;
}

async function walk(dir: string, rel: string, depth: number, tracked: ReadonlySet<string>, out: PruneResult): Promise<void> {
  if (depth > MAX_DEPTH) return;

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // A tree that changed under us is not a reason to fail the snapshot.
    return;
  }

  for (const entry of entries) {
    // `isDirectory()` is false for a symlink, so a symlinked node_modules is
    // left alone and travels as the symlink it is.
    if (!entry.isDirectory()) continue;

    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    // `.git` IS the snapshot. Nothing under it is ever a build artefact, and a
    // name collision in there (`.git/lfs/cache`) must not cost history.
    if (childRel === ".git") continue;

    const childPath = join(dir, entry.name);
    if (EXCLUDED_NAMES.has(entry.name)) {
      if (tracked.has(childRel)) {
        out.kept.push(childRel);
        await walk(childPath, childRel, depth + 1, tracked, out);
        continue;
      }
      out.bytesRemoved += await sizeOf(childPath, 0);
      await rm(childPath, { recursive: true, force: true });
      out.removed.push(childRel);
      continue;
    }

    await walk(childPath, childRel, depth + 1, tracked, out);
  }
}

/**
 * Every directory with at least one tracked file under it, repo-relative.
 *
 * Returns an empty set when `root` is not a git repository -- in which case
 * nothing is tracked and the excludes apply unconditionally, which is the right
 * answer rather than a failure.
 */
async function trackedDirectories(root: string): Promise<ReadonlySet<string>> {
  let listing: string;
  try {
    // `-c safe.directory` because the tree was extracted from a volume written
    // by uid 10001 and git refuses to look at a repo it thinks belongs to
    // someone else.
    listing = await git(["-C", root, "-c", `safe.directory=${root}`, "ls-files", "-z"], { timeoutMs: 60_000 });
  } catch {
    return new Set();
  }

  const dirs = new Set<string>();
  for (const path of listing.split("\0")) {
    if (path === "") continue;
    const parts = path.split("/");
    // Every ancestor directory of a tracked file counts as tracked.
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
  }
  return dirs;
}

async function sizeOf(dir: string, depth: number): Promise<number> {
  if (depth > MAX_DEPTH) return 0;
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await sizeOf(path, depth + 1);
    } else if (entry.isFile()) {
      total += await fileSize(path);
    }
  }
  return total;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
