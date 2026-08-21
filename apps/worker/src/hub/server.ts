import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { desc, eq } from "drizzle-orm";
import { WebSocketServer, type WebSocket } from "ws";
import type { AnyEventRow, ServerFrame } from "@codex-clone/core";
import { redact } from "@codex-clone/core";
import { latestSeq, readEvents, runs, type Database } from "@codex-clone/db";
import { MAX_CLIENT_FRAME_BYTES, isAllowedOrigin, parseClientFrame, parseHandshake } from "./protocol.js";

/**
 * The live transcript hub (PLAN.md §3.6).
 *
 *   worker: docker attach ──▶ events table ──▶ THIS ──▶ browser
 *
 * It lives in the worker because the worker sees every event first: hosting it
 * here means zero fanout hops and no second process that has to be told what
 * happened. The web app stays a stock Next.js App Router process with no custom
 * server and no upgrade handler of its own.
 *
 * The invariant this exists to protect:
 *
 *     frame === row === { seq, type, payload }
 *
 * A frame sent live and a row returned by `GET /api/tasks/:id/events` are built
 * by the same function in @codex-clone/db, so ONE client reducer serves both and
 * they cannot drift. The only thing broadcast that is not also persisted is the
 * token delta, and that is an explicit, named exception (`DeltaFrame`).
 *
 * Backfill-then-live is done with a buffer rather than a lock: a subscription
 * that is still reading history parks anything published in the meantime and
 * flushes it afterwards, dropping whatever the history read already covered. A
 * reconnect therefore resumes exactly, and the client never sees a gap.
 */

export interface EventHubOptions {
  db: Database;
  port: number;
  /** Local app: never 0.0.0.0. */
  host: string;
  /** Cancel from the UI rides this socket; the queue does the actual stopping. */
  onCancel?: (runId: string) => Promise<boolean>;
  log?: (message: string) => void;
  /** Dead-peer detection. A tab closed by force never sends a close frame. */
  heartbeatMs?: number;
  /**
   * Control-API handlers, keyed `"<METHOD> <path>"`.
   *
   * These exist because some actions need the workspace VOLUME -- deriving a
   * diff, committing and pushing a branch -- and the worker is the only process
   * that can reach one. The web app proxies to them server-side so the browser
   * still talks to exactly one origin.
   */
  routes?: Record<string, (body: unknown) => Promise<{ status: number; body: unknown }>>;
}

/** A control request is a couple of ids; anything larger is a bug or an attack. */
export const MAX_CONTROL_BODY_BYTES = 64 * 1024;

interface Subscription {
  socket: WebSocket;
  taskId: string;
  /** While backfilling, live rows are parked in `pending` rather than sent. */
  phase: "backfilling" | "live";
  pending: AnyEventRow[];
  /** Highest seq this socket has been sent; the dedupe line for the flush. */
  highestSent: number;
  alive: boolean;
}

export const DEFAULT_HEARTBEAT_MS = 30_000;

export class EventHub {
  #wss: WebSocketServer | null = null;
  #http: Server | null = null;
  #heartbeat: NodeJS.Timeout | null = null;
  readonly #byTask = new Map<string, Set<Subscription>>();
  readonly #subs = new Map<WebSocket, Subscription>();
  /**
   * runId -> taskId, so a token delta (which knows only its run) can be routed.
   * Populated by the supervisor at run start rather than by a database lookup,
   * because deltas arrive per token and a query per token is not a design.
   */
  readonly #runToTask = new Map<string, string>();

  constructor(private readonly options: EventHubOptions) {}

  get connectionCount(): number {
    return this.#subs.size;
  }

  get subscriberCount(): number {
    let total = 0;
    for (const set of this.#byTask.values()) total += set.size;
    return total;
  }

  /** The bound port. Differs from the requested one only when it was 0. */
  get port(): number {
    const address = this.#http?.address();
    return typeof address === "object" && address !== null ? address.port : this.options.port;
  }

  async listen(): Promise<void> {
    // One HTTP server carrying both protocols: the WebSocket the browser
    // subscribes on, and the control API the web app calls for actions that
    // need the workspace volume (milestone 7's push). The worker owns
    // everything with a lifecycle, so it is the only process that can reach a
    // Docker volume -- and the web app stays a stock App Router process with no
    // custom server of its own.
    const http = createServer((req, res) => {
      void this.#onRequest(req, res).catch((err: unknown) => {
        this.#log(`[hub] control handler crashed: ${redact(String(err))}`);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      });
    });

    const wss = new WebSocketServer({
      server: http,
      // A browser sending megabytes at this is a bug or an attack; either way
      // it must not be able to grow the worker's heap.
      maxPayload: MAX_CLIENT_FRAME_BYTES,
    });

    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(this.options.port, this.options.host, () => {
        http.removeListener("error", reject);
        resolve();
      });
    });

    wss.on("connection", (socket, request) => this.#onConnection(socket, request));
    wss.on("error", (err: Error) => this.#log(`[hub] server error: ${redact(err.message)}`));

    this.#http = http;
    this.#wss = wss;
    this.#heartbeat = setInterval(() => this.#sweep(), this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    // The hub must not be the reason the process refuses to exit.
    this.#heartbeat.unref();
  }

  async close(): Promise<void> {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;

    const wss = this.#wss;
    const http = this.#http;
    this.#wss = null;
    this.#http = null;
    if (!wss || !http) return;

    for (const socket of this.#subs.keys()) socket.close(1001, "worker shutting down");
    this.#subs.clear();
    this.#byTask.clear();
    this.#runToTask.clear();

    await new Promise<void>((resolve) => {
      wss.close(() => http.close(() => resolve()));
      // `close()` waits for every client to go; a half-closed browser could
      // otherwise hold shutdown open indefinitely.
      setTimeout(() => {
        for (const client of wss.clients) client.terminate();
        http.closeAllConnections?.();
        resolve();
      }, 2_000).unref();
    });
  }

  /**
   * The control API.
   *
   * Requests must be JSON, and that is load-bearing rather than tidy: a
   * cross-origin `fetch` carrying `content-type: application/json` triggers a
   * CORS preflight, and this server answers no CORS headers at all -- so a page
   * on some other site cannot reach these endpoints even though they listen on
   * loopback with no auth. The web app calls them server-side, where the
   * browser's rules do not apply.
   */
  async #onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };

    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") {
      return send(200, { ok: true, subscribers: this.subscriberCount, activeRuns: this.#runToTask.size });
    }

    const route = this.options.routes?.[`${req.method ?? "GET"} ${url.pathname}`];
    if (!route) return send(404, { error: "not found" });

    if (!(req.headers["content-type"] ?? "").includes("application/json")) {
      return send(415, { error: "requests to the control API must be application/json" });
    }

    let body: unknown = {};
    try {
      const raw = await readBody(req);
      if (raw.trim() !== "") body = JSON.parse(raw);
    } catch (err) {
      return send(400, { error: `body is not valid JSON: ${redact(String(err))}` });
    }

    const result = await route(body);
    return send(result.status, result.body);
  }

  /** Teaches the hub which task a run belongs to, for delta routing. */
  bindRun(runId: string, taskId: string): void {
    this.#runToTask.set(runId, taskId);
  }

  releaseRun(runId: string): void {
    this.#runToTask.delete(runId);
  }

  /**
   * Broadcasts a durable event. Called by the supervisor ONLY for rows that
   * were actually written -- a replayed row is already in every subscriber's
   * history and must not be sent twice.
   */
  publish(row: AnyEventRow): void {
    this.#runToTask.set(row.runId, row.taskId);
    const subs = this.#byTask.get(row.taskId);
    if (!subs) return;

    for (const sub of subs) {
      if (sub.phase === "backfilling") {
        sub.pending.push(row);
        continue;
      }
      this.#send(sub, { kind: "event", event: row });
    }
  }

  /**
   * The one thing broadcast but never persisted (PLAN.md §3.6).
   *
   * Deltas are an optimistic overlay the client discards the moment the durable
   * `message` with the same messageId lands. They are not written here, are not
   * replayed on reconnect, and cannot appear in history -- which is why a
   * reload can never resurrect a half-finished sentence.
   */
  publishDelta(runId: string, messageId: string, text: string): void {
    const taskId = this.#runToTask.get(runId);
    if (!taskId) return;
    const subs = this.#byTask.get(taskId);
    if (!subs) return;

    const frame: ServerFrame = { kind: "delta", runId, messageId, text };
    for (const sub of subs) {
      // A subscriber still reading history has no message to overlay yet, and
      // the delta is worthless a second later. Dropping beats buffering.
      if (sub.phase === "live") this.#send(sub, frame);
    }
  }

  #onConnection(socket: WebSocket, request: IncomingMessage): void {
    if (!isAllowedOrigin(request.headers.origin)) {
      this.#log(`[hub] rejected a connection from origin ${String(request.headers.origin)}`);
      socket.close(1008, "origin not allowed");
      return;
    }

    const sub: Subscription = {
      socket,
      taskId: "",
      phase: "live",
      pending: [],
      highestSent: 0,
      alive: true,
    };
    this.#subs.set(socket, sub);

    socket.on("pong", () => {
      sub.alive = true;
    });
    socket.on("error", (err: Error) => this.#log(`[hub] socket error: ${redact(err.message)}`));
    socket.on("close", () => this.#detach(socket));
    socket.on("message", (data) => {
      void this.#onMessage(sub, data.toString()).catch((err: unknown) => {
        this.#log(`[hub] message handler failed: ${redact(String(err))}`);
      });
    });

    // Multiple tabs on one task are just multiple connections; nothing here is
    // per-task singleton state.
    const handshake = parseHandshake(request.url);
    if (handshake) {
      void this.#subscribe(sub, handshake.taskId, handshake.after).catch((err: unknown) => {
        this.#log(`[hub] backfill failed: ${redact(String(err))}`);
      });
    }
  }

  async #onMessage(sub: Subscription, raw: string): Promise<void> {
    const parsed = parseClientFrame(raw);
    if (!parsed.ok) {
      this.#log(`[hub] ignoring a client frame: ${parsed.reason}`);
      return;
    }

    if (parsed.frame.kind === "subscribe") {
      await this.#subscribe(sub, parsed.frame.taskId, parsed.frame.after);
      return;
    }

    // Cancel rides this socket rather than a REST call precisely because the
    // transport is bidirectional (PLAN.md §3.6). The queue closes the meter
    // first, then SIGTERMs with a grace period.
    const { runId } = parsed.frame;
    this.#log(`[hub] cancel requested for run ${runId.slice(0, 8)}`);
    const accepted = (await this.options.onCancel?.(runId)) ?? false;
    if (!accepted) this.#log(`[hub] run ${runId.slice(0, 8)} is not in flight here; cancel ignored`);
  }

  async #subscribe(sub: Subscription, taskId: string, after: number): Promise<void> {
    this.#detachFromTask(sub);

    sub.taskId = taskId;
    sub.phase = "backfilling";
    sub.pending = [];
    sub.highestSent = after;

    let set = this.#byTask.get(taskId);
    if (!set) {
      set = new Set();
      this.#byTask.set(taskId, set);
    }
    set.add(sub);

    const [latest, runId] = await Promise.all([latestSeq(this.options.db, taskId), latestRunId(this.options.db, taskId)]);
    // Sent before backfill so the client can reset its reducer and knows when
    // catching up is finished.
    this.#send(sub, { kind: "hello", taskId, runId, latestSeq: latest });

    // `#send` advances `highestSent`, so by the end of this loop it is the
    // high-water mark of everything history covered.
    for (const row of await readEvents(this.options.db, taskId, after)) {
      this.#send(sub, { kind: "event", event: row });
    }

    // Anything published while that read was in flight. `highestSent` is the
    // dedupe line: whatever the history query already returned is dropped here.
    const parked = sub.pending;
    sub.pending = [];
    sub.phase = "live";
    for (const row of parked) {
      if (row.seq <= sub.highestSent) continue;
      this.#send(sub, { kind: "event", event: row });
    }
  }

  #send(sub: Subscription, frame: ServerFrame): void {
    if (sub.socket.readyState !== sub.socket.OPEN) return;
    if (frame.kind === "event" && frame.event.seq > sub.highestSent) sub.highestSent = frame.event.seq;
    sub.socket.send(JSON.stringify(frame), (err) => {
      if (err) this.#log(`[hub] send failed: ${redact(err.message)}`);
    });
  }

  #detach(socket: WebSocket): void {
    const sub = this.#subs.get(socket);
    if (!sub) return;
    this.#detachFromTask(sub);
    this.#subs.delete(socket);
  }

  #detachFromTask(sub: Subscription): void {
    if (sub.taskId === "") return;
    const set = this.#byTask.get(sub.taskId);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) this.#byTask.delete(sub.taskId);
  }

  /**
   * A tab closed by force, a laptop suspended, a network that vanished: none of
   * those send a close frame, and each would otherwise leave a subscription
   * fanning events into a socket nobody is reading.
   */
  #sweep(): void {
    for (const [socket, sub] of this.#subs) {
      if (!sub.alive) {
        socket.terminate();
        this.#detach(socket);
        continue;
      }
      sub.alive = false;
      socket.ping();
    }
  }

  #log(message: string): void {
    this.options.log?.(message);
  }
}

/** Capped: a runaway client must not be able to grow the worker's heap. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CONTROL_BODY_BYTES) {
        reject(new Error(`body exceeded ${MAX_CONTROL_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The task's most recent run, for the hello frame's cursor. */
async function latestRunId(db: Database, taskId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return row?.id ?? null;
}
