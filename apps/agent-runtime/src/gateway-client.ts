import { request } from "node:http";
import type { GatewayChunk, GatewayRequest } from "@codex-clone/core";

/**
 * The sandbox's only outbound channel for model calls.
 *
 * There is no API key anywhere in this process. The request goes to a unix
 * socket bind-mounted from the host; the host attaches the credential and
 * forwards to api.openai.com (PLAN.md section 3.3). Consequences that matter:
 * prompt injection has nothing to exfiltrate, cost metering has exactly one
 * home, and tests swap in a fake and run with no network at all.
 */
export interface GatewayClient {
  send(req: GatewayRequest): AsyncIterable<GatewayChunk>;
}

/**
 * The gateway is a single point of failure for every running task (PLAN.md
 * section 7, risk 4). The requirement there is explicit: the failure mode must
 * be a clear event, never a hang. So every path out of this client -- socket
 * refused, mid-stream reset, silent stall -- terminates the iterator with a
 * `refused` chunk, which the loop already knows how to wind down on.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

export interface UnixSocketGatewayOptions {
  socketPath: string;
  path?: string;
  /** Longest gap between bytes before we declare the gateway dead. */
  idleTimeoutMs?: number;
}

export class UnixSocketGatewayClient implements GatewayClient {
  constructor(private readonly options: UnixSocketGatewayOptions) {}

  async *send(req: GatewayRequest): AsyncIterable<GatewayChunk> {
    const body = Buffer.from(JSON.stringify(req), "utf8");
    const idleTimeoutMs = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    const queue: GatewayChunk[] = [];
    let done = false;
    let wake: (() => void) | null = null;
    const signal = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const fail = (message: string) => {
      queue.push({ type: "refused", reason: "upstream_error", message });
      done = true;
      signal();
    };

    const req$ = request({
      socketPath: this.options.socketPath,
      path: this.options.path ?? "/v1/responses",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(body.byteLength),
        accept: "application/x-ndjson",
      },
    });

    req$.setTimeout(idleTimeoutMs, () => {
      req$.destroy();
      fail(`gateway did not respond within ${idleTimeoutMs}ms`);
    });
    req$.on("error", (err: Error) => fail(`gateway socket error: ${err.message}`));

    req$.on("response", (res) => {
      if (res.statusCode !== undefined && res.statusCode >= 400) {
        // Read the (short) error body so the transcript says what went wrong.
        let detail = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          if (detail.length < 2048) detail += c;
        });
        res.on("end", () => fail(`gateway returned HTTP ${res.statusCode}: ${detail.trim()}`));
        return;
      }

      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line === "") continue;
          const parsed = parseChunk(line);
          if (parsed) queue.push(parsed);
        }
        signal();
      });
      res.on("end", () => {
        const tail = buffer.trim();
        if (tail !== "") {
          const parsed = parseChunk(tail);
          if (parsed) queue.push(parsed);
        }
        done = true;
        signal();
      });
      res.on("error", (err: Error) => fail(`gateway stream error: ${err.message}`));
    });

    req$.end(body);

    try {
      for (;;) {
        while (queue.length > 0) yield queue.shift() as GatewayChunk;
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      req$.destroy();
    }
  }
}

const CHUNK_TYPES = new Set(["delta", "reasoning", "tool_call", "done", "refused"]);

function parseChunk(line: string): GatewayChunk | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return null;
    const type = (parsed as { type?: unknown }).type;
    if (typeof type !== "string" || !CHUNK_TYPES.has(type)) return null;
    return parsed as GatewayChunk;
  } catch {
    return null;
  }
}
