import { spawn } from "node:child_process";
import type { ToolDef, ToolOutcome } from "./types.js";
import { optionalNumber, optionalString, requireString, truncate } from "./types.js";
import { resolveInWorkspace } from "./read-file.js";

export const DEFAULT_GREP_MAX_MATCHES = 200;

/**
 * ripgrep, not a JS walker: it respects .gitignore, skips binaries, and is
 * fast enough on a large repo that the model does not learn to avoid it. That
 * is why the base image installs it rather than leaving search to `shell`.
 */
export const grepTool: ToolDef = {
  name: "grep",
  schema: {
    type: "function",
    name: "grep",
    description:
      "Search the workspace with ripgrep. Respects .gitignore and skips binary files. " +
      "Returns path:line:text matches.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Rust regex to search for." },
        path: { type: "string", description: "Workspace-relative subdirectory or file to search." },
        glob: { type: "string", description: "Only search files matching this glob, e.g. '*.ts'." },
        max_matches: { type: "number", description: `Cap on returned matches (default ${DEFAULT_GREP_MAX_MATCHES}).` },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },

  run(args, ctx): Promise<ToolOutcome> {
    const pattern = requireString(args, "pattern");
    const glob = optionalString(args, "glob");
    const searchPath = optionalString(args, "path");
    const maxMatches = Math.max(1, Math.floor(optionalNumber(args, "max_matches") ?? DEFAULT_GREP_MAX_MATCHES));

    const rgArgs = ["--line-number", "--no-heading", "--color", "never", "--max-count", String(maxMatches)];
    if (glob) rgArgs.push("--glob", glob);
    rgArgs.push("--regexp", pattern);

    if (searchPath) {
      try {
        rgArgs.push(resolveInWorkspace(ctx, searchPath));
      } catch (err) {
        return Promise.resolve({ ok: false, output: (err as Error).message, truncated: false });
      }
    }

    return new Promise<ToolOutcome>((resolve) => {
      const child = spawn("rg", rgArgs, { cwd: ctx.workspacePath, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => {
        if (stdout.length < ctx.maxOutputBytes * 8) stdout += c.toString("utf8");
      });
      child.stderr.on("data", (c: Buffer) => {
        if (stderr.length < 4096) stderr += c.toString("utf8");
      });
      child.on("error", (err: Error) =>
        resolve({ ok: false, output: `ripgrep is unavailable: ${err.message}`, truncated: false, exitCode: 127 }),
      );
      child.on("close", (code) => {
        // rg exits 1 for "no matches", which is a successful search, not an error.
        if (code === 1 && stderr.trim() === "") {
          resolve({ ok: true, output: "no matches", truncated: false, exitCode: 1 });
          return;
        }
        if (code !== 0) {
          resolve({ ok: false, output: stderr.trim() || `ripgrep exited ${code}`, truncated: false, exitCode: code ?? 1 });
          return;
        }
        const cut = truncate(stdout, ctx.maxOutputBytes);
        resolve({ ok: true, output: cut.text, truncated: cut.truncated, exitCode: 0 });
      });
    });
  },
};
