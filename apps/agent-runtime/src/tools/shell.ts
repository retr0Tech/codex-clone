import { spawn } from "node:child_process";
import type { ToolDef, ToolOutcome } from "./types.js";
import { optionalNumber, requireString, truncate } from "./types.js";

export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
export const MAX_SHELL_TIMEOUT_MS = 600_000;

/**
 * Arbitrary command execution, deliberately unrestricted *inside* the sandbox.
 *
 * There is no command allowlist here and that is the design: the container is
 * the security boundary (no capabilities, non-root, read-only rootfs, no
 * credentials, read-only workspace in ask mode). Trying to also police command
 * strings would give a false sense of a second boundary while breaking honest
 * builds.
 */
export const shellTool: ToolDef = {
  name: "shell",
  schema: {
    type: "function",
    name: "shell",
    description:
      "Run a shell command in the workspace. Returns combined stdout and stderr plus the exit code. " +
      "In ask mode the workspace is mounted read-only, so any write will fail with EROFS.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command line, executed with bash -lc." },
        timeout_ms: {
          type: "number",
          description: `Kill the command after this many milliseconds (default ${DEFAULT_SHELL_TIMEOUT_MS}).`,
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },

  run(args, ctx): Promise<ToolOutcome> {
    const command = requireString(args, "command");
    const timeoutMs = Math.min(optionalNumber(args, "timeout_ms") ?? DEFAULT_SHELL_TIMEOUT_MS, MAX_SHELL_TIMEOUT_MS);

    return new Promise<ToolOutcome>((resolve) => {
      const child = spawn("bash", ["-lc", command], {
        cwd: ctx.workspacePath,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      let settled = false;
      // Cap in-memory accumulation well above the report limit so a runaway
      // command cannot OOM the runtime while still leaving room for the tail.
      const hardCap = ctx.maxOutputBytes * 8;
      const collect = (chunk: Buffer) => {
        if (output.length < hardCap) output += chunk.toString("utf8");
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        const cut = truncate(`${output}\n[timed out after ${timeoutMs}ms and was killed]`, ctx.maxOutputBytes);
        resolve({ ok: false, output: cut.text, truncated: cut.truncated, exitCode: 124 });
      }, timeoutMs);

      const finish = (code: number, extra = "") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const cut = truncate(output + extra, ctx.maxOutputBytes);
        resolve({ ok: code === 0, output: cut.text, truncated: cut.truncated, exitCode: code });
      };

      child.on("error", (err: Error) => finish(127, `\n[failed to spawn: ${err.message}]`));
      child.on("close", (code, signal) => finish(code ?? (signal ? 137 : 1), signal ? `\n[killed by ${signal}]` : ""));
    });
  },
};
