/**
 * The `apply_patch` envelope.
 *
 * Deliberately not a unified diff: a model cannot count line numbers reliably,
 * and a diff whose @@ header is one off either fails loudly or, worse, applies
 * in the wrong place. This format is located purely by matching context lines,
 * so a hunk either finds its exact surroundings or is rejected -- it can never
 * apply somewhere plausible-looking.
 *
 *   *** Begin Patch
 *   *** Add File: src/new.ts
 *   +export const x = 1;
 *   *** Update File: src/old.ts
 *   *** Move to: src/renamed.ts
 *   @@ class Foo
 *    unchanged context line
 *   -removed line
 *   +added line
 *   *** Delete File: src/gone.ts
 *   *** End Patch
 */

export type HunkLine = { op: " " | "-" | "+"; text: string };

export interface Hunk {
  /** Text after `@@`, used only as a search hint. */
  header?: string;
  lines: HunkLine[];
}

export type PatchOp =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: Hunk[] };

export class PatchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchParseError";
  }
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const EOF_MARKER = "*** End of File";

export function parsePatch(patch: string): PatchOp[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");

  let i = 0;
  while (i < lines.length && lines[i]?.trim() === "") i++;
  if (lines[i]?.trim() !== BEGIN) throw new PatchParseError(`patch must start with "${BEGIN}"`);
  i++;

  const ops: PatchOp[] = [];
  let sawEnd = false;

  while (i < lines.length) {
    const line = lines[i] as string;

    if (line.trim() === END) {
      sawEnd = true;
      break;
    }

    if (line.startsWith(ADD)) {
      const path = requirePath(line.slice(ADD.length));
      const body: string[] = [];
      i++;
      while (i < lines.length && !isSectionStart(lines[i] as string)) {
        const l = lines[i] as string;
        if (l.startsWith("+")) body.push(l.slice(1));
        else if (l.trim() === "") body.push("");
        else throw new PatchParseError(`in "Add File: ${path}", every line must start with "+": ${JSON.stringify(l)}`);
        i++;
      }
      ops.push({ kind: "add", path, contents: body.length === 0 ? "" : `${body.join("\n")}\n` });
      continue;
    }

    if (line.startsWith(DELETE)) {
      ops.push({ kind: "delete", path: requirePath(line.slice(DELETE.length)) });
      i++;
      continue;
    }

    if (line.startsWith(UPDATE)) {
      const path = requirePath(line.slice(UPDATE.length));
      i++;
      let moveTo: string | undefined;
      if (i < lines.length && (lines[i] as string).startsWith(MOVE)) {
        moveTo = requirePath((lines[i] as string).slice(MOVE.length));
        i++;
      }

      const hunks: Hunk[] = [];
      let current: Hunk | null = null;
      while (i < lines.length && !isSectionStart(lines[i] as string)) {
        const l = lines[i] as string;
        if (l.startsWith("@@")) {
          if (current) hunks.push(current);
          const header = l.slice(2).trim();
          current = header ? { header, lines: [] } : { lines: [] };
        } else if (l.trim() === EOF_MARKER) {
          // Positional marker from the original format; context matching makes
          // it redundant here.
        } else {
          if (!current) current = { lines: [] };
          const op = l.charAt(0);
          if (op === "+" || op === "-" || op === " ") current.lines.push({ op, text: l.slice(1) });
          else if (l === "") current.lines.push({ op: " ", text: "" });
          else throw new PatchParseError(`in "Update File: ${path}", unexpected line: ${JSON.stringify(l)}`);
        }
        i++;
      }
      if (current) hunks.push(current);
      if (hunks.length === 0) throw new PatchParseError(`"Update File: ${path}" has no hunks`);

      ops.push(moveTo ? { kind: "update", path, moveTo, hunks } : { kind: "update", path, hunks });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }
    throw new PatchParseError(`unexpected line outside a file section: ${JSON.stringify(line)}`);
  }

  if (!sawEnd) throw new PatchParseError(`patch must end with "${END}"`);
  if (ops.length === 0) throw new PatchParseError("patch contains no file operations");
  return ops;
}

function isSectionStart(line: string): boolean {
  return (
    line.startsWith(ADD) ||
    line.startsWith(DELETE) ||
    line.startsWith(UPDATE) ||
    line.trim() === END ||
    line.trim() === BEGIN
  );
}

function requirePath(raw: string): string {
  const path = raw.trim();
  if (path === "") throw new PatchParseError("file section has an empty path");
  return path;
}

/** The lines a hunk expects to find, and the lines it puts in their place. */
export function hunkBeforeAfter(hunk: Hunk): { before: string[]; after: string[] } {
  const before: string[] = [];
  const after: string[] = [];
  for (const { op, text } of hunk.lines) {
    if (op === " ") {
      before.push(text);
      after.push(text);
    } else if (op === "-") before.push(text);
    else after.push(text);
  }
  return { before, after };
}
