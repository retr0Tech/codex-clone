import type { EventPayloadMap } from "@codex-clone/core";

/**
 * Parsing `git diff` output into the frozen `diff` event payload.
 *
 * Pure, and separated from the plumbing that produces the input, because this
 * is the part with edge cases: NUL-delimited records, rename pairs that occupy
 * three fields instead of two, and binary files that report `-` where a number
 * belongs. All three are silent-corruption bugs if guessed at, and none of them
 * needs Docker to test.
 *
 * `-z` throughout on purpose: without it git quotes paths containing spaces or
 * non-ASCII and the parser would have to un-quote them, which is a second
 * chance to be wrong about someone's filename.
 */

export type DiffFile = EventPayloadMap["diff"]["files"][number];

/**
 * `git diff --name-status -z -M`
 *
 *   A\0path\0M\0path\0R100\0old\0new\0
 *
 * A rename spends three fields; everything else spends two. Copies (`C`) are
 * shaped like renames and are reported as additions, which is what they are
 * from the reader's point of view.
 */
export function parseNameStatus(output: string): Array<{ path: string; status: DiffFile["status"] }> {
  const fields = output.split("\0").filter((field) => field !== "");
  const files: Array<{ path: string; status: DiffFile["status"] }> = [];

  let i = 0;
  while (i < fields.length) {
    const code = fields[i++] as string;
    const kind = code.charAt(0);

    if (kind === "R" || kind === "C") {
      // old, new. The old path is not listed separately: a rename is one entry.
      i += 1;
      const to = fields[i++];
      if (to === undefined) break;
      files.push({ path: to, status: kind === "R" ? "renamed" : "added" });
      continue;
    }

    const path = fields[i++];
    if (path === undefined) break;
    files.push({ path, status: statusOf(kind) });
  }

  return files;
}

function statusOf(code: string): DiffFile["status"] {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    default:
      // M, T (type change), U (unmerged) and anything git invents later all
      // mean "this file is different"; claiming more than that would be a lie.
      return "modified";
  }
}

/**
 * `git diff --numstat -z -M`
 *
 *   10\t2\tpath\0                  ordinary
 *   10\t2\t\0old\0new\0            rename: the path field is EMPTY and the two
 *                                  paths follow as separate records
 *   -\t-\tpath\0                   binary: counts are not applicable
 */
export function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const fields = output.split("\0");
  const counts = new Map<string, { additions: number; deletions: number }>();

  let i = 0;
  while (i < fields.length) {
    const record = fields[i++];
    if (record === undefined || record === "") continue;

    const [rawAdd, rawDel, path] = record.split("\t");
    if (rawAdd === undefined || rawDel === undefined) continue;

    const additions = countOf(rawAdd);
    const deletions = countOf(rawDel);

    if (path === undefined || path === "") {
      // Rename: skip the old path, key the counts on the new one.
      i += 1;
      const to = fields[i++];
      if (to === undefined) break;
      counts.set(to, { additions, deletions });
      continue;
    }
    counts.set(path, { additions, deletions });
  }

  return counts;
}

/** `-` means binary. Zero is the honest answer; NaN would render as "NaN". */
function countOf(raw: string): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

export function mergeFileStats(
  statuses: Array<{ path: string; status: DiffFile["status"] }>,
  counts: Map<string, { additions: number; deletions: number }>,
): DiffFile[] {
  return statuses.map((entry) => ({
    path: entry.path,
    status: entry.status,
    additions: counts.get(entry.path)?.additions ?? 0,
    deletions: counts.get(entry.path)?.deletions ?? 0,
  }));
}

/**
 * A patch large enough to matter is a patch nobody reads, and it travels
 * through Postgres, a WebSocket frame and a React render on the way. Cut it at
 * a line boundary and say so honestly rather than shipping a megabyte.
 */
export const MAX_PATCH_BYTES = 256 * 1024;

export function truncatePatch(patch: string, limit = MAX_PATCH_BYTES): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(patch, "utf8") <= limit) return { patch, truncated: false };

  const clipped = Buffer.from(patch, "utf8").subarray(0, limit).toString("utf8");
  const lastNewline = clipped.lastIndexOf("\n");
  const body = lastNewline > 0 ? clipped.slice(0, lastNewline + 1) : clipped;
  return {
    patch: `${body}\n… patch truncated at ${limit} bytes; the file list above is complete.\n`,
    truncated: true,
  };
}
