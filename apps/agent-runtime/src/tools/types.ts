import type { SandboxMode, ToolName } from "@codex-clone/core";

export interface ToolContext {
  workspacePath: string;
  mode: SandboxMode;
  /** Output above this is cut, and `truncated` is set. See truncate(). */
  maxOutputBytes: number;
}

export interface ToolOutcome {
  ok: boolean;
  output: string;
  truncated: boolean;
  exitCode?: number;
}

/** OpenAI Responses API function-tool definition. */
export interface ToolSchema {
  type: "function";
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolDef {
  name: ToolName;
  schema: ToolSchema;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}

/**
 * Truncation is reported, never hidden. A model that cannot tell its output
 * was cut will confidently reason about the half it did not see, so the
 * `truncated` flag on the durable `tool_result` event has to be honest -- and
 * the marker is left in the text the model actually reads.
 */
export function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };

  // Keep the head and the tail: a compiler's first error and its final summary
  // are both load-bearing, and the middle rarely is.
  const headBytes = Math.floor(maxBytes * 0.7);
  const tailBytes = maxBytes - headBytes;
  const head = buf.subarray(0, headBytes).toString("utf8");
  const tail = buf.subarray(buf.byteLength - tailBytes).toString("utf8");
  const omitted = buf.byteLength - headBytes - tailBytes;
  return {
    text: `${head}\n\n... [${omitted} bytes omitted by the sandbox: output exceeded ${maxBytes} bytes] ...\n\n${tail}`,
    truncated: true,
  };
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new TypeError(`argument "${key}" must be a string`);
  return v;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new TypeError(`argument "${key}" must be a string`);
  return v;
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new TypeError(`argument "${key}" must be a number`);
  return v;
}
