import { and, asc, eq, gt, max, ne } from "drizzle-orm";
import type { AnyEventRow, DurableEventType, EventPayloadMap } from "@codex-clone/core";
import { events } from "./schema.js";
import type { Database } from "./index.js";

/**
 * The durable transcript.
 *
 * This lives in the DB package rather than in the worker for one reason: TWO
 * processes read it. The worker's WebSocket hub backfills from it before going
 * live, and the web app's `GET /api/tasks/:id/events` serves it as history.
 * PLAN.md §3.6 makes one client reducer serve both, and that only holds if a
 * history row and a live frame are the same shape -- which in turn only holds
 * if there is one function that builds them. Two copies of `fromRecord`, one
 * per app, is precisely how that invariant would quietly rot.
 *
 * Two more invariants live here, and both are load-bearing:
 *
 *  1. **Writes are idempotent.** `DockerSandbox.attach()` follows the container
 *     log with no `tail`, so a worker that restarts mid-run replays the stream
 *     from its first byte. Combined with the replay-stable numbering in
 *     `apps/worker/src/runner/seq.ts`, `onConflictDoNothing` on
 *     `events_run_seq_idx` turns that replay into a no-op instead of a
 *     duplicated transcript.
 *
 *  2. **A row read back is byte-identical in shape to a live frame.**
 *     `EventRow.createdAt` is an ISO string but the column is `timestamptz`, so
 *     the conversion happens on both edges, here, once.
 */

export function toRow<T extends DurableEventType>(input: {
  runId: string;
  taskId: string;
  seq: number;
  type: T;
  payload: EventPayloadMap[T];
  createdAt?: string;
}): AnyEventRow {
  return {
    seq: input.seq,
    runId: input.runId,
    taskId: input.taskId,
    type: input.type,
    payload: input.payload,
    createdAt: input.createdAt ?? new Date().toISOString(),
  } as AnyEventRow;
}

/**
 * Appends one event. Returns true when this call actually wrote it, false when
 * the row was already there -- which is the normal outcome of a replay and is
 * how the caller knows not to re-broadcast it.
 */
export async function appendEvent(db: Database, row: AnyEventRow): Promise<boolean> {
  const inserted = await db
    .insert(events)
    .values({
      runId: row.runId,
      taskId: row.taskId,
      seq: row.seq,
      type: row.type,
      payload: row.payload,
      // ISO string on the wire, timestamptz in the column.
      createdAt: new Date(row.createdAt),
    })
    .onConflictDoNothing({ target: [events.runId, events.seq] })
    .returning({ id: events.id });

  return inserted.length > 0;
}

/**
 * History for a task, as `AnyEventRow[]` -- the exact type the socket streams.
 *
 * Ordered by seq, which the worker keeps monotonic across the whole task, so
 * `after` is a single cursor that survives follow-up runs -- the same cursor
 * the WebSocket handshake carries.
 */
export async function readEvents(db: Database, taskId: string, after = 0): Promise<AnyEventRow[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.taskId, taskId), gt(events.seq, after)))
    .orderBy(asc(events.seq), asc(events.id));

  return rows.map(fromRecord);
}

/** The highest seq the server holds for a task; the `hello` frame's cursor. */
export async function latestSeq(db: Database, taskId: string): Promise<number> {
  const [row] = await db.select({ value: max(events.seq) }).from(events).where(eq(events.taskId, taskId));
  return row?.value ?? 0;
}

/**
 * The high-water mark set by every run of this task EXCEPT the given one.
 *
 * Deliberately excludes the current run: it is used to pick that run's base, so
 * it has to return the same answer on a restart -- by which time the run has
 * already written events of its own.
 */
export async function highestSeqBefore(db: Database, taskId: string, runId: string): Promise<number> {
  const [row] = await db
    .select({ value: max(events.seq) })
    .from(events)
    .where(and(eq(events.taskId, taskId), ne(events.runId, runId)));
  return row?.value ?? 0;
}

/** Highest seq written by one specific run; used to resume a mid-run supervision. */
export async function highestSeqForRun(db: Database, runId: string): Promise<number> {
  const [row] = await db.select({ value: max(events.seq) }).from(events).where(eq(events.runId, runId));
  return row?.value ?? 0;
}

function fromRecord(row: typeof events.$inferSelect): AnyEventRow {
  return {
    seq: row.seq,
    runId: row.runId,
    taskId: row.taskId,
    type: row.type as DurableEventType,
    payload: row.payload as EventPayloadMap[DurableEventType],
    // Back to the ISO string the client reducer and the live socket both use.
    createdAt: row.createdAt.toISOString(),
  } as AnyEventRow;
}
