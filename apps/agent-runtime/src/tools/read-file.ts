import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolContext, ToolDef, ToolOutcome } from "./types.js";
import { optionalNumber, requireString, truncate } from "./types.js";

/**
 * Confines a path to the workspace.
 *
 * The container already denies anything worth reading -- no credentials, no
 * host filesystem -- so this is defence in depth rather than the boundary. It
 * exists because a tool that will happily cat /etc/shadow makes every future
 * reviewer stop and check whether it matters, and the answer should be
 * obviously "it cannot".
 */
export function resolveInWorkspace(ctx: ToolContext, path: string): string {
  const abs = isAbsolute(path) ? resolve(path) : resolve(ctx.workspacePath, path);
  const rel = relative(resolve(ctx.workspacePath), abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes the workspace: ${path}`);
  }
  return abs;
}

export const readFileTool: ToolDef = {
  name: "read_file",
  schema: {
    type: "function",
    name: "read_file",
    description: "Read a UTF-8 file from the workspace, optionally a line range. Paths are workspace-relative.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        start_line: { type: "number", description: "1-based first line to return." },
        end_line: { type: "number", description: "1-based last line to return, inclusive." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },

  async run(args, ctx): Promise<ToolOutcome> {
    const path = requireString(args, "path");
    const startLine = optionalNumber(args, "start_line");
    const endLine = optionalNumber(args, "end_line");

    let abs: string;
    try {
      abs = resolveInWorkspace(ctx, path);
    } catch (err) {
      return { ok: false, output: (err as Error).message, truncated: false };
    }

    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch (err) {
      return { ok: false, output: `cannot read ${path}: ${(err as Error).message}`, truncated: false };
    }

    if (startLine !== undefined || endLine !== undefined) {
      const lines = content.split("\n");
      const from = Math.max(1, Math.floor(startLine ?? 1));
      const to = Math.min(lines.length, Math.floor(endLine ?? lines.length));
      content = lines
        .slice(from - 1, to)
        .map((line, i) => `${from + i}\t${line}`)
        .join("\n");
    }

    const cut = truncate(content, ctx.maxOutputBytes);
    return { ok: true, output: cut.text, truncated: cut.truncated };
  },
};
