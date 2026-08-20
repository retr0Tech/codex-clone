import { StringDecoder } from "node:string_decoder";
import type { AnyEventRow, DurableEventType } from "@codex-clone/core";

/**
 * The agent's stdout is the only channel out of the sandbox, and it is written
 * by a process running attacker-influenced code. So this parser treats every
 * byte as hostile:
 *
 *   - lines arrive split across arbitrary chunk boundaries -> buffered;
 *   - a malformed line must not kill the transcript -> surfaced as an `error`
 *     event and the stream continues;
 *   - a line that never terminates must not exhaust worker memory -> capped.
 *
 * Losing one event to a bad write is recoverable. Losing the stream is not.
 */

const DURABLE_EVENT_TYPES: ReadonlySet<string> = new Set<DurableEventType>([
  "phase",
  "setup_log",
  "reasoning",
  "message",
  "tool_call",
  "tool_result",
  "diff",
  "status",
  "error",
]);

/** A single event line larger than this is dropped rather than buffered. */
export const MAX_LINE_BYTES = 1024 * 1024;

export interface ParserContext {
  runId: string;
  taskId: string;
}

export class MalformedEventError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "MalformedEventError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Structural validation only. The payload shape per type is the agent's
 * responsibility; the host checks the envelope it indexes on -- seq, type,
 * and the ids it uses as foreign keys.
 */
export function parseEventLine(line: string, ctx: ParserContext): AnyEventRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new MalformedEventError("event line is not valid JSON", "bad_json");
  }
  if (!isRecord(parsed)) throw new MalformedEventError("event line is not an object", "not_object");

  const { seq, type, payload } = parsed;
  if (typeof seq !== "number" || !Number.isFinite(seq)) {
    throw new MalformedEventError("event has no numeric seq", "bad_seq");
  }
  if (typeof type !== "string" || !DURABLE_EVENT_TYPES.has(type)) {
    throw new MalformedEventError(`unknown durable event type: ${String(type)}`, "bad_type");
  }
  if (!isRecord(payload)) throw new MalformedEventError("event has no object payload", "bad_payload");

  // The agent is told its own ids, but it does not get to claim someone
  // else's: a run may only ever append to its own log.
  return {
    seq,
    runId: ctx.runId,
    taskId: ctx.taskId,
    type,
    payload,
    createdAt: typeof parsed["createdAt"] === "string" ? parsed["createdAt"] : new Date().toISOString(),
  } as AnyEventRow;
}

/**
 * Incremental, chunk-boundary-safe line splitter. `push` returns the rows
 * completed by this chunk; `flush` returns whatever a final partial line held.
 */
export class NdjsonEventParser {
  #buffer = "";
  #nextFallbackSeq: number;
  #overlong = false;
  // A multibyte character can straddle a chunk boundary just as easily as a
  // newline can. Buffer.toString would turn one into replacement characters.
  #decoder = new StringDecoder("utf8");

  constructor(
    private readonly ctx: ParserContext,
    seqStart = 0,
  ) {
    this.#nextFallbackSeq = seqStart;
  }

  push(chunk: string | Buffer): AnyEventRow[] {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    const out: AnyEventRow[] = [];

    let idx: number;
    while ((idx = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, idx);
      this.#buffer = this.#buffer.slice(idx + 1);
      if (this.#overlong) {
        // We are discarding the tail of a line we already rejected.
        this.#overlong = false;
        continue;
      }
      const row = this.#consume(line);
      if (row) out.push(row);
    }

    if (this.#buffer.length > MAX_LINE_BYTES) {
      out.push(
        this.#errorRow("line_too_long", `dropped an event line exceeding ${MAX_LINE_BYTES} bytes`),
      );
      this.#buffer = "";
      this.#overlong = true;
    }
    return out;
  }

  flush(): AnyEventRow[] {
    const tail = this.#buffer + this.#decoder.end();
    this.#buffer = "";
    if (this.#overlong || tail.trim() === "") return [];
    const row = this.#consume(tail);
    return row ? [row] : [];
  }

  #consume(line: string): AnyEventRow | null {
    if (line.trim() === "") return null;
    try {
      const row = parseEventLine(line, this.ctx);
      // Keep the fallback counter ahead of anything the agent has emitted so a
      // synthesized error never collides with a real seq.
      if (row.seq >= this.#nextFallbackSeq) this.#nextFallbackSeq = row.seq + 1;
      return row;
    } catch (err) {
      const code = err instanceof MalformedEventError ? err.code : "parse_failed";
      const detail = err instanceof Error ? err.message : String(err);
      return this.#errorRow(code, `${detail}: ${truncateForMessage(line)}`);
    }
  }

  #errorRow(code: string, message: string): AnyEventRow {
    return {
      seq: this.#nextFallbackSeq++,
      runId: this.ctx.runId,
      taskId: this.ctx.taskId,
      type: "error",
      // Malformed output is a bug in the agent, not a transient fault, so it is
      // reported as non-retryable rather than silently swallowed.
      payload: { code, message, retryable: false },
      createdAt: new Date().toISOString(),
    };
  }
}

function truncateForMessage(line: string): string {
  const limit = 240;
  return line.length <= limit ? line : `${line.slice(0, limit)}... (${line.length} bytes)`;
}
