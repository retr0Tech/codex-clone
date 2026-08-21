/**
 * A deliberately small unified-diff parser.
 *
 * The `diff` event carries the patch as the host's `git diff` produced it
 * (PLAN.md §3.8) — the point of that design is that the UI shows reality, so
 * the renderer's job is to make the real bytes readable, not to reinterpret
 * them. Anything unrecognised is passed through as a `meta` line rather than
 * dropped, so a patch this parser does not fully understand still renders.
 */

export type PatchLineType = "add" | "del" | "ctx" | "hunk" | "meta";

export interface PatchLine {
  type: PatchLineType;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface PatchFile {
  /** Path as `git diff` reported it, preferring the post-image name. */
  path: string;
  lines: PatchLine[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function pathFromHeader(header: string): string {
  // "diff --git a/src/x.ts b/src/x.ts" -> "src/x.ts"
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
  if (match) return match[2] ?? match[1] ?? header;
  return header.replace(/^diff --git\s*/, "");
}

export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  let oldNo = 0;
  let newNo = 0;

  // A patch conventionally ends with a newline; splitting on it would otherwise
  // manufacture a phantom trailing context line.
  for (const raw of patch.replace(/\n$/, "").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      current = { path: pathFromHeader(raw), lines: [] };
      files.push(current);
      oldNo = 0;
      newNo = 0;
      continue;
    }
    if (!current) {
      // A bare patch with no `diff --git` header (git format-patch fragment, or
      // a single-file diff). Open an anonymous file so nothing is lost.
      current = { path: "", lines: [] };
      files.push(current);
    }

    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      current.lines.push({ type: "hunk", text: raw, oldNo: null, newNo: null });
      continue;
    }

    if (raw.startsWith("+++") || raw.startsWith("---")) {
      current.lines.push({ type: "meta", text: raw, oldNo: null, newNo: null });
      continue;
    }
    if (raw.startsWith("+")) {
      current.lines.push({ type: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
      continue;
    }
    if (raw.startsWith("-")) {
      current.lines.push({ type: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
      continue;
    }
    if (raw.startsWith(" ") || raw === "") {
      // Inside a hunk a blank line is context; before the first hunk it is noise.
      if (oldNo === 0 && newNo === 0 && raw === "") continue;
      current.lines.push({ type: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
      continue;
    }
    current.lines.push({ type: "meta", text: raw, oldNo: null, newNo: null });
  }

  return files.filter((f) => f.lines.length > 0);
}

export function countChanges(file: PatchFile): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of file.lines) {
    if (line.type === "add") additions += 1;
    else if (line.type === "del") deletions += 1;
  }
  return { additions, deletions };
}
