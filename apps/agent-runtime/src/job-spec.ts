import { readFile } from "node:fs/promises";
import type { AgentJobSpec } from "@codex-clone/core";

/**
 * The job spec arrives as a file bind-mounted into the sandbox (or on stdin).
 * It is NOT read from the environment: env is visible via `docker inspect` and
 * to every process the agent spawns, so this codebase treats env as a public
 * surface and never routes job data or credentials through it.
 *
 * The type is imported from the host package type-only, so the two ends cannot
 * drift, and nothing from the host package is linked into the container
 * bundle. It is still re-validated here: a file mounted into a sandbox is
 * untrusted input at the point of parse.
 */

export type { AgentJobSpec };

export class InvalidJobSpecError extends Error {
  constructor(message: string) {
    super(`invalid job spec: ${message}`);
    this.name = "InvalidJobSpecError";
  }
}

function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v === "") throw new InvalidJobSpecError(`${key} must be a non-empty string`);
  return v;
}

function optionalStr(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new InvalidJobSpecError(`${key} must be a string`);
  return v;
}

function int(obj: Record<string, unknown>, key: string, fallback: number): number {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new InvalidJobSpecError(`${key} must be a non-negative number`);
  }
  return Math.floor(v);
}

export function parseJobSpec(raw: string): AgentJobSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidJobSpecError("not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidJobSpecError("not an object");
  }
  const o = parsed as Record<string, unknown>;

  const mode = o["mode"];
  if (mode !== "ask" && mode !== "code") throw new InvalidJobSpecError("mode must be 'ask' or 'code'");

  const setupScript = optionalStr(o, "setupScript");
  return {
    taskId: str(o, "taskId"),
    runId: str(o, "runId"),
    mode,
    prompt: str(o, "prompt"),
    baseSha: str(o, "baseSha"),
    workspacePath: optionalStr(o, "workspacePath") ?? "/workspace",
    model: str(o, "model"),
    gatewaySocketPath: optionalStr(o, "gatewaySocketPath") ?? "/run/gateway.sock",
    ...(setupScript ? { setupScript } : {}),
    seqStart: int(o, "seqStart", 0),
    maxTurns: Math.max(1, int(o, "maxTurns", 40)),
    maxToolOutputBytes: Math.max(1024, int(o, "maxToolOutputBytes", 16 * 1024)),
  };
}

/** File first (the normal path), stdin as the fallback. Never env. */
export async function loadJobSpec(opts: {
  path?: string | undefined;
  stdin: NodeJS.ReadableStream;
}): Promise<AgentJobSpec> {
  if (opts.path) {
    try {
      return parseJobSpec(await readFile(opts.path, "utf8"));
    } catch (err) {
      if (err instanceof InvalidJobSpecError) throw err;
      // Fall through to stdin: `docker run -i` without the bind mount is a
      // legitimate way to drive this binary during development.
    }
  }
  const chunks: Buffer[] = [];
  for await (const chunk of opts.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") {
    throw new InvalidJobSpecError(
      `no job spec at ${opts.path ?? "(no path configured)"} and stdin was empty`,
    );
  }
  return parseJobSpec(raw);
}
