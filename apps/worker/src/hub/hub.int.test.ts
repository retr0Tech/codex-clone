import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { WebSocket } from "ws";
import type { AnyEventRow, ServerFrame } from "@codex-clone/core";
import { appendEvent, createDb, events, readEvents, repos, runs, tasks, toRow, type Database } from "@codex-clone/db";
import { EventHub } from "./server.js";
import { TEST_DATABASE_URL, postgresUnavailable, withTimeout } from "../runner/testing.js";

/**
 * The hub, against a real Postgres and real sockets.
 *
 * What is being pinned down here is PLAN.md §3.6's central claim: a live frame
 * and a history row are the same thing, backfill-then-live has no gap and no
 * duplicate, a reconnect with `after` resumes exactly, and token deltas are
 * broadcast but NEVER written. Each of those is easy to believe and easy to get
 * subtly wrong.
 *
 * Skips with a reason when Postgres is absent. Every socket wait is bounded and
 * reports what it did see -- a hub bug must fail the suite, not hang it.
 */

const skip = await postgresUnavailable();
const WAIT_MS = 5_000;

describe("transcript hub", { skip: skip === false ? undefined : skip }, () => {
  let db: Database;
  let closeDb: () => Promise<unknown>;
  let hub: EventHub;
  let cancelled: string[] = [];
  const sockets = new Set<WebSocket>();
  const taskIds: string[] = [];
  let repoId: string;
  let taskId: string;
  let runId: string;

  before(async () => {
    ({ db, close: closeDb } = createDb(TEST_DATABASE_URL));
    await withTimeout(db.execute("select 1"), 10_000, "connecting to Postgres");

    repoId = `repo-hub-${randomUUID().slice(0, 8)}`;
    await db.insert(repos).values({
      id: repoId,
      owner: "fixture",
      name: "hub",
      fullName: `fixture/hub-${randomUUID().slice(0, 8)}`,
      defaultBranch: "main",
    });

    hub = new EventHub({
      db,
      // Port 0: the OS picks a free one, so the suite cannot collide with a
      // worker the developer happens to have running.
      port: 0,
      host: "127.0.0.1",
      onCancel: (id) => {
        cancelled.push(id);
        return Promise.resolve(true);
      },
    });
    await hub.listen();
  });

  after(async () => {
    for (const socket of sockets) socket.terminate();
    await hub?.close().catch(() => undefined);
    if (db) {
      for (const id of taskIds) await db.delete(tasks).where(eq(tasks.id, id)).catch(() => undefined);
      await db.delete(repos).where(eq(repos.id, repoId)).catch(() => undefined);
    }
    await closeDb?.().catch(() => undefined);
  });

  beforeEach(async () => {
    cancelled = [];
    taskId = `task-hub-${randomUUID().slice(0, 8)}`;
    runId = `run-hub-${randomUUID().slice(0, 8)}`;
    taskIds.push(taskId);
    await db.insert(tasks).values({
      id: taskId,
      repoId,
      title: "hub fixture",
      mode: "code",
      baseBranch: "main",
      baseSha: "0".repeat(40),
      status: "running",
    });
    await db.insert(runs).values({ id: runId, taskId, prompt: "stream me", status: "running" });
  });

  /** A client that records every frame, so assertions can be about the stream. */
  function connect(query: string): { socket: WebSocket; frames: ServerFrame[]; open: Promise<void> } {
    const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/${query}`);
    sockets.add(socket);
    const frames: ServerFrame[] = [];
    socket.on("message", (data) => frames.push(JSON.parse(data.toString()) as ServerFrame));

    const open = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`socket did not open within ${WAIT_MS}ms`)), WAIT_MS);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return { socket, frames, open };
  }

  /** Bounded, and it reports the frames it saw rather than just timing out. */
  async function waitFor(frames: ServerFrame[], predicate: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; saw ${frames.length} frame(s): ${describe_(frames)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function describe_(frames: ServerFrame[]): string {
    return frames
      .map((f) => (f.kind === "event" ? `${f.event.seq}:${f.event.type}` : f.kind))
      .join(", ");
  }

  function eventsOf(frames: ServerFrame[]): AnyEventRow[] {
    return frames.flatMap((f) => (f.kind === "event" ? [f.event] : []));
  }

  async function seed(count: number, from = 64): Promise<AnyEventRow[]> {
    const rows: AnyEventRow[] = [];
    for (let i = 0; i < count; i += 1) {
      const row = toRow({ runId, taskId, seq: from + i * 64, type: "reasoning", payload: { text: `step ${i}` } });
      await appendEvent(db, row);
      rows.push(row);
    }
    return rows;
  }

  it("says hello, then backfills history, then goes live", async () => {
    const seeded = await seed(3);
    const client = connect(`?taskId=${taskId}&after=0`);
    await client.open;

    await waitFor(client.frames, () => eventsOf(client.frames).length === 3, "the backfill");

    const hello = client.frames[0];
    assert.equal(hello?.kind, "hello");
    assert.equal(hello?.kind === "hello" ? hello.taskId : "", taskId);
    assert.equal(hello?.kind === "hello" ? hello.runId : "", runId);
    assert.equal(hello?.kind === "hello" ? hello.latestSeq : 0, seeded[2]!.seq);

    // A history row on the wire is byte-identical to what the REST endpoint
    // returns -- same function builds both.
    assert.deepEqual(eventsOf(client.frames), seeded);

    const live = toRow({ runId, taskId, seq: 1000, type: "message", payload: { messageId: "m1", role: "assistant", text: "done" } });
    await appendEvent(db, live);
    hub.publish(live);

    await waitFor(client.frames, () => eventsOf(client.frames).length === 4, "the live frame");
    assert.deepEqual(eventsOf(client.frames).at(-1), live);

    client.socket.close();
  });

  it("resumes from `after`, sending only the gap", async () => {
    const seeded = await seed(4);
    const cursor = seeded[1]!.seq;

    const client = connect(`?taskId=${taskId}&after=${cursor}`);
    await client.open;
    await waitFor(client.frames, () => eventsOf(client.frames).length === 2, "the gap");

    assert.deepEqual(eventsOf(client.frames), seeded.slice(2));
    client.socket.close();
  });

  it("serves several tabs on one task independently", async () => {
    await seed(2);
    const a = connect(`?taskId=${taskId}&after=0`);
    const b = connect(`?taskId=${taskId}&after=128`);
    await Promise.all([a.open, b.open]);

    await waitFor(a.frames, () => eventsOf(a.frames).length === 2, "tab A's backfill");
    await waitFor(b.frames, () => eventsOf(b.frames).length === 0 && b.frames.length === 1, "tab B's hello");

    const live = toRow({ runId, taskId, seq: 2000, type: "phase", payload: { phase: "agent" } });
    await appendEvent(db, live);
    hub.publish(live);

    // Both tabs see the live frame; each keeps its own cursor for the backfill.
    await waitFor(a.frames, () => eventsOf(a.frames).length === 3, "tab A's live frame");
    await waitFor(b.frames, () => eventsOf(b.frames).length === 1, "tab B's live frame");
    assert.deepEqual(eventsOf(a.frames).at(-1), live);
    assert.deepEqual(eventsOf(b.frames).at(-1), live);

    a.socket.close();
    b.socket.close();
  });

  /**
   * The race the buffer exists for: an event published while the subscription
   * is still reading history must be delivered exactly once -- not dropped
   * because it arrived too early, and not duplicated because the history query
   * also returned it.
   */
  it("loses nothing and duplicates nothing when an event lands mid-backfill", async () => {
    const seeded = await seed(40);
    const client = connect(`?taskId=${taskId}&after=0`);

    // Published without waiting for `open`, so it collides with the backfill.
    const racer = toRow({ runId, taskId, seq: 5000, type: "reasoning", payload: { text: "raced" } });
    await appendEvent(db, racer);
    hub.publish(racer);

    await client.open;
    await waitFor(client.frames, () => eventsOf(client.frames).length === seeded.length + 1, "every frame");

    const delivered = eventsOf(client.frames);
    const seqs = delivered.map((row) => row.seq);
    assert.equal(new Set(seqs).size, seqs.length, `duplicate seqs: ${seqs.join(", ")}`);
    assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, "frames must arrive in seq order");
    assert.ok(seqs.includes(racer.seq), "the raced event must not be lost");

    client.socket.close();
  });

  /**
   * Deltas are dropped for a subscription that is still reading history -- they
   * are worthless a second later, so buffering them would be worse than losing
   * them. The test therefore has to wait until the subscription is genuinely
   * live, and receiving a backfilled frame is the observable proof of that:
   * the hub flips to live synchronously after the last history send, before any
   * of it can reach a client.
   */
  it("broadcasts token deltas without ever writing them", async () => {
    const opener = await seed(1);
    const client = connect(`?taskId=${taskId}&after=0`);
    await client.open;
    await waitFor(client.frames, () => eventsOf(client.frames).length === 1, "the backfill, which means live");
    assert.deepEqual(eventsOf(client.frames), opener);

    hub.bindRun(runId, taskId);
    hub.publishDelta(runId, "m1", "Hel");
    hub.publishDelta(runId, "m1", "lo");

    await waitFor(client.frames, () => client.frames.filter((f) => f.kind === "delta").length === 2, "two deltas");

    const stored = await db.select().from(events).where(eq(events.taskId, taskId));
    assert.equal(stored.length, 1, "the seeded event only -- a delta must never reach the event log");

    // The coalesced message is the durable truth; the deltas that built it were
    // overlay. Reconnecting proves it: history contains the message and no
    // trace of the tokens, so a reload cannot resurrect a half-typed sentence.
    const message = toRow({
      runId,
      taskId,
      seq: 128,
      type: "message",
      payload: { messageId: "m1", role: "assistant", text: "Hello" },
    });
    await appendEvent(db, message);
    hub.publish(message);
    await waitFor(client.frames, () => eventsOf(client.frames).length === 2, "the durable message");

    const history = await readEvents(db, taskId);
    assert.deepEqual(history, [...opener, message]);
    assert.equal(
      history.some((row) => JSON.stringify(row).includes("Hel\"")),
      false,
      "no partial token text may survive in history",
    );

    client.socket.close();
  });

  it("drops a delta for a run it has never been told about", async () => {
    await seed(1);
    const client = connect(`?taskId=${taskId}&after=0`);
    await client.open;
    // Same reason as above: wait until the subscription is live, or this would
    // pass for the wrong reason -- a backfilling subscriber drops deltas too.
    await waitFor(client.frames, () => eventsOf(client.frames).length === 1, "the backfill, which means live");

    hub.publishDelta(`run-unknown-${randomUUID().slice(0, 6)}`, "m9", "nowhere");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(client.frames.filter((f) => f.kind === "delta").length, 0);

    client.socket.close();
  });

  it("routes a cancel frame to the queue", async () => {
    const client = connect(`?taskId=${taskId}&after=0`);
    await client.open;
    client.socket.send(JSON.stringify({ kind: "cancel", runId }));

    const deadline = Date.now() + WAIT_MS;
    while (cancelled.length === 0) {
      if (Date.now() > deadline) throw new Error("the cancel frame never reached onCancel");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(cancelled, [runId]);

    client.socket.close();
  });

  it("survives a malformed frame instead of dropping the connection", async () => {
    const client = connect(`?taskId=${taskId}&after=0`);
    await client.open;
    client.socket.send("{not json");
    client.socket.send(JSON.stringify({ kind: "nonsense" }));

    const live = toRow({ runId, taskId, seq: 64, type: "phase", payload: { phase: "agent" } });
    await appendEvent(db, live);
    hub.publish(live);

    await waitFor(client.frames, () => eventsOf(client.frames).length === 1, "the socket to still be usable");
    client.socket.close();
  });

  it("refuses a connection from an origin that is not loopback", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/?taskId=${taskId}`, {
      origin: "https://evil.example",
    });
    sockets.add(socket);

    const code = await withTimeout(
      new Promise<number>((resolve, reject) => {
        socket.once("close", (c: number) => resolve(c));
        socket.once("error", reject);
      }),
      WAIT_MS,
      "the rejected socket to close",
    );
    assert.equal(code, 1008);
  });

  /**
   * The shape claim the single reducer rests on: what the socket sends and what
   * `GET /api/tasks/:id/events` returns are not merely similar, they are equal.
   * The client fold is proven separately in eventReducer.test.ts; this is the
   * half that could drift, because it crosses a process boundary.
   */
  it("a live frame's payload is identical to the history row", async () => {
    const seeded = await seed(6);
    const client = connect(`?taskId=${taskId}&after=0`);
    await client.open;
    await waitFor(client.frames, () => eventsOf(client.frames).length === seeded.length, "the backfill");

    const overSocket = eventsOf(client.frames);
    const overHttp = await readEvents(db, taskId, 0);
    assert.deepEqual(overSocket, overHttp);

    // Including the timestamp: an ISO string on both edges, so an item's `at`
    // does not change identity between a live render and a reload.
    for (const row of overSocket) assert.match(row.createdAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);

    client.socket.close();
  });
});
