import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { GatewayChunk, GatewayRequest, RunBudget, TokenUsage } from "@codex-clone/core";
import { DEFAULT_BUDGET, registerSecret, WIND_DOWN_INSTRUCTION } from "@codex-clone/core";
import type { CredentialStore } from "./credentials.js";
import { MeterRegistry, type RunMeterSnapshot } from "./metering.js";
import { computeCost } from "./pricing.js";
import type { Upstream } from "./upstream.js";

/**
 * The host model gateway.
 *
 * An HTTP server on a unix socket that the sandbox bind-mounts. It is the only
 * component that holds the OpenAI key, the only component that sees every
 * model call for a run, and therefore the only place budgets and cost
 * accounting can honestly live (PLAN.md sections 3.3 and 3.4).
 *
 *   container: POST unix:/run/gateway.sock /v1/responses   <- holds NO key
 *        v
 *   this: attach key -> api.openai.com, stream back as NDJSON GatewayChunks,
 *         meter tokens and cost, enforce RunBudget, inject the wind-down
 *
 * A unix socket rather than a TCP port on purpose: filesystem permissions are
 * the access control, so nothing else on the machine can reach it, and there
 * is no port for a browser page to hit.
 */

export interface GatewayServerOptions {
  socketPath: string;
  credentials: CredentialStore;
  upstream: Upstream;
  budget?: RunBudget;
  now?: () => number;
  /**
   * Ephemeral token overlay for the live transcript (PLAN.md section 3.6).
   * These are broadcast over the WebSocket and NEVER persisted; the durable
   * `message` event the agent emits at end of turn is the truth. Wired up by
   * the WS hub in milestone 6.
   */
  onDelta?: (runId: string, messageId: string, text: string) => void;
  /** Called after every completed turn so the worker can persist run cost. */
  onUsage?: (runId: string, usage: TokenUsage, snapshot: RunMeterSnapshot) => void;
  onError?: (message: string) => void;
}

export class GatewayServer {
  readonly meters: MeterRegistry;
  #server: Server | null = null;

  constructor(private readonly options: GatewayServerOptions) {
    this.meters = new MeterRegistry(options.budget ?? DEFAULT_BUDGET, options.now ?? Date.now);
  }

  async listen(): Promise<void> {
    const path = this.options.socketPath;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // A socket left behind by a crashed worker would make listen() fail with
    // EADDRINUSE forever.
    await removeStaleSocket(path);

    const server = createServer((req, res) => {
      void this.#handle(req, res).catch((err: unknown) => {
        this.options.onError?.(`gateway handler crashed: ${String(err)}`);
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal error\n");
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    /**
     * The socket itself is world-accessible; its DIRECTORY is 0700.
     *
     * That split is forced by the deployment: the agent runs as uid 10001
     * inside the container and the worker runs as the host user, so a 0600
     * socket owned by the host uid is simply unreachable from the sandbox --
     * the uids do not correspond. Access control therefore lives on the
     * containing directory, which only the host user can traverse, exactly as
     * for the Docker socket itself.
     *
     * Reaching the socket still requires either being the host user or having
     * it explicitly bind-mounted into your container, and holding it buys an
     * attacker metered, budget-capped model calls -- not the key.
     */
    await chmod(path, 0o666);
    this.#server = server;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(this.options.socketPath).catch(() => undefined);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, activeRuns: this.meters.size }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/responses") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found\n");
      return;
    }

    const body = await readBody(req);
    let parsed: GatewayRequest;
    try {
      parsed = parseGatewayRequest(body);
    } catch (err) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end(`${(err as Error).message}\n`);
      return;
    }

    // From here on the response is always 200 with an NDJSON chunk stream,
    // including for refusals. The agent has exactly one thing to parse, and a
    // refusal is a normal part of the protocol rather than an HTTP error it
    // would have to special-case (PLAN.md section 7, risk 4: a clear event,
    // never a hang).
    res.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      connection: "close",
    });
    const write = (chunk: GatewayChunk) => {
      res.write(`${JSON.stringify(chunk)}\n`);
    };

    const meter = this.meters.for(parsed.runId);
    const admission = meter.admit();

    if (admission.action === "refuse") {
      write({
        type: "refused",
        reason: admission.breach,
        message: `run budget exhausted (${admission.breach}); the wind-down turn has already been used`,
      });
      res.end();
      return;
    }

    const apiKey = await this.options.credentials.getOpenAiKey();
    if (!apiKey) {
      write({
        type: "refused",
        reason: "upstream_error",
        message: "no OpenAI API key is configured; add one in Settings",
      });
      res.end();
      return;
    }
    // Belt and braces: if this value ever reaches a log line, redact it.
    registerSecret(apiKey);

    const input =
      admission.action === "wind_down" ? injectWindDown(parsed.input) : parsed.input;

    // If the container goes away mid-turn, stop paying for the upstream call.
    const abort = new AbortController();
    res.on("close", () => abort.abort());

    let sawDone = false;
    try {
      for await (const event of this.options.upstream.stream({
        model: parsed.model,
        input,
        tools: parsed.tools,
        apiKey,
        signal: abort.signal,
      })) {
        switch (event.type) {
          case "delta":
            // Ephemeral: forwarded to the agent (which coalesces it into the
            // durable `message`) and handed to the live overlay. Not persisted
            // by anyone.
            this.options.onDelta?.(parsed.runId, event.messageId, event.text);
            write({ type: "delta", messageId: event.messageId, text: event.text });
            break;
          case "reasoning":
            write({ type: "reasoning", text: event.text });
            break;
          case "tool_call":
            write({ type: "tool_call", callId: event.callId, name: event.name, args: event.args });
            break;
          case "done": {
            sawDone = true;
            const usage = computeCost(parsed.model, event.usage);
            meter.record(usage);
            this.options.onUsage?.(parsed.runId, usage, meter.snapshot());
            write({ type: "done", usage });
            break;
          }
          case "error":
            this.options.onError?.(event.message);
            write({ type: "refused", reason: "upstream_error", message: event.message });
            res.end();
            return;
        }
      }
    } catch (err) {
      const message = `gateway failed to reach the model: ${err instanceof Error ? err.message : String(err)}`;
      this.options.onError?.(message);
      write({ type: "refused", reason: "upstream_error", message });
      res.end();
      return;
    }

    if (!sawDone) {
      write({ type: "refused", reason: "upstream_error", message: "upstream ended without reporting usage" });
    }
    res.end();
  }
}

/**
 * One extra instruction, for exactly one turn.
 *
 * The gateway does not hard-kill on breach: it tells the agent to stop
 * starting work and summarise, then lets the worker SIGTERM afterwards. The
 * instruction goes at the END of the input so it is the most recent thing the
 * model sees.
 */
export function injectWindDown(input: unknown): unknown {
  const message = { role: "system", content: WIND_DOWN_INSTRUCTION };
  if (Array.isArray(input)) return [...(input as unknown[]), message];
  if (typeof input === "string") return [{ role: "user", content: input }, message];
  return [input, message];
}

export function parseGatewayRequest(body: string): GatewayRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o["runId"] !== "string" || o["runId"] === "") throw new Error("runId is required");
  if (typeof o["model"] !== "string" || o["model"] === "") throw new Error("model is required");
  if (!("input" in o)) throw new Error("input is required");

  return {
    runId: o["runId"],
    model: o["model"],
    input: o["input"],
    tools: o["tools"],
    stream: o["stream"] !== false,
  };
}

/** Cap the body so a runaway container cannot exhaust worker memory. */
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error(`request body exceeded ${MAX_REQUEST_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const st = await stat(path);
    if (st.isSocket()) await unlink(path);
  } catch {
    // Nothing there; nothing to clean up.
  }
}
