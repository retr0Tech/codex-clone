import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolContext, ToolDef, ToolOutcome } from "./types.js";
import { requireString, truncate } from "./types.js";
import { resolveInWorkspace } from "./read-file.js";
import type { PatchOp } from "./patch-format.js";
import { hunkBeforeAfter, parsePatch, PatchParseError } from "./patch-format.js";

/**
 * The only tool that writes.
 *
 * It is absent from the tool list in ask mode -- see buildToolRegistry -- and
 * the workspace is mounted read-only there as well, so the restriction holds
 * at two independent layers and neither is a prompt.
 *
 * Note what this tool does NOT do: report what it changed. The durable `diff`
 * event is derived by the HOST with `git diff <baseSha>` after the turn
 * (PLAN.md section 3.8), so the diff view shows what is actually on disk
 * rather than what the agent believes it wrote.
 */
export const applyPatchTool: ToolDef = {
  name: "apply_patch",
  schema: {
    type: "function",
    name: "apply_patch",
    description:
      "Apply a patch to the workspace. Format:\n" +
      "*** Begin Patch\n" +
      "*** Add File: path/to/new.ts\n" +
      "+first line\n" +
      "*** Update File: path/to/existing.ts\n" +
      "@@ optional anchor\n" +
      " unchanged context line\n" +
      "-removed line\n" +
      "+added line\n" +
      "*** Delete File: path/to/old.ts\n" +
      "*** End Patch\n" +
      "Hunks are located by matching their context lines exactly, so include enough surrounding " +
      "context to be unambiguous. Line numbers are never used.",
    parameters: {
      type: "object",
      properties: { patch: { type: "string", description: "The full patch envelope." } },
      required: ["patch"],
      additionalProperties: false,
    },
  },

  async run(args, ctx): Promise<ToolOutcome> {
    const patch = requireString(args, "patch");
    try {
      const ops = parsePatch(patch);
      const summary = await applyOps(ops, ctx);
      const cut = truncate(summary, ctx.maxOutputBytes);
      return { ok: true, output: cut.text, truncated: cut.truncated };
    } catch (err) {
      const message = err instanceof PatchParseError ? err.message : (err as Error).message;
      return { ok: false, output: message, truncated: false };
    }
  },
};

async function applyOps(ops: PatchOp[], ctx: ToolContext): Promise<string> {
  // Resolve and validate every path before touching disk, so a patch that
  // references an escaping path leaves nothing half-applied.
  for (const op of ops) {
    resolveInWorkspace(ctx, op.path);
    if (op.kind === "update" && op.moveTo) resolveInWorkspace(ctx, op.moveTo);
  }

  const done: string[] = [];
  for (const op of ops) {
    const abs = resolveInWorkspace(ctx, op.path);
    switch (op.kind) {
      case "add": {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, op.contents, "utf8");
        done.push(`added ${op.path}`);
        break;
      }
      case "delete": {
        await rm(abs, { force: false });
        done.push(`deleted ${op.path}`);
        break;
      }
      case "update": {
        const original = await readFile(abs, "utf8");
        const updated = applyHunks(original, op, ctx);
        if (op.moveTo) {
          const target = resolveInWorkspace(ctx, op.moveTo);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, updated, "utf8");
          if (target !== abs) await rm(abs, { force: true });
          done.push(`updated ${op.path} -> ${op.moveTo}`);
        } else {
          await writeFile(abs, updated, "utf8");
          done.push(`updated ${op.path}`);
        }
        break;
      }
    }
  }
  return `${done.length} change(s):\n${done.map((d) => `  ${d}`).join("\n")}`;
}

/** Exported for tests: hunk location is the part most likely to regress. */
export function applyHunks(original: string, op: Extract<PatchOp, { kind: "update" }>, _ctx?: ToolContext): string {
  const endsWithNewline = original.endsWith("\n");
  const lines = original.split("\n");
  if (endsWithNewline) lines.pop();

  let cursor = 0;
  for (const [index, hunk] of op.hunks.entries()) {
    const { before, after } = hunkBeforeAfter(hunk);
    if (before.length === 0) {
      throw new Error(
        `${op.path}: hunk ${index + 1} has no context or removed lines, so there is nowhere to anchor it. ` +
          `Include at least one unchanged context line.`,
      );
    }

    // Search forward from the previous hunk first, so repeated blocks are
    // consumed in document order; then fall back to a whole-file search.
    let at = indexOfBlock(lines, before, cursor);
    if (at === -1) at = indexOfBlock(lines, before, 0);
    if (at === -1) {
      throw new Error(
        `${op.path}: hunk ${index + 1} did not match the file. Expected to find:\n` +
          before.map((l) => `  ${l}`).join("\n"),
      );
    }

    lines.splice(at, before.length, ...after);
    cursor = at + after.length;
  }

  const joined = lines.join("\n");
  return endsWithNewline || joined === "" ? `${joined}\n` : joined;
}

function indexOfBlock(haystack: string[], needle: string[], from: number): number {
  for (let i = from; i + needle.length <= haystack.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}
