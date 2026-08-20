/**
 * The transcript reducer.
 *
 * PLAN.md §3.6 says a live WebSocket frame and a row from the history endpoint
 * are the *same* `{seq, type, payload}` shape, and that one reducer therefore
 * serves both. This file is that reducer, and the whole reason the transport
 * was designed that way: live rendering and reload-and-replay run identical
 * code over identical data, so they are structurally incapable of drifting.
 *
 * Two rules keep that promise honest:
 *
 *  1. `transcriptReducer` is the ONLY entry point. History rows are wrapped as
 *     `{kind: "event", event}` frames and pushed through the same door as the
 *     socket's. There is no second "replay" code path to fall out of sync.
 *
 *  2. State is derived from an ordered, deduplicated event list. Frames may
 *     arrive out of order or twice (a reconnect that backfills from a stale
 *     cursor does exactly this); the reducer canonicalises them, so folding
 *     events 1..N in any arrival order yields the same state as folding them
 *     in seq order. `foldThenReplayEquivalence` in the tests pins that down.
 *
 * Token deltas are the single explicit exception to "everything broadcast is
 * also persisted". They are an optimistic overlay held OUTSIDE the durable
 * fold and dropped the instant the durable `message` with the matching
 * messageId lands, so a replay of history can never resurrect them.
 */

import type {
  AnyEventRow,
  DeltaFrame,
  EventPayloadMap,
  RunPhase,
  RunStatus,
  ServerFrame,
  ToolName,
} from "@codex-clone/core";

/* -------------------------------------------------------------------------- */
/* View model                                                                  */
/* -------------------------------------------------------------------------- */

interface ItemBase {
  /** Stable across re-folds: derived from the event that opened the item. */
  id: string;
  runId: string;
  seq: number;
  at: string;
}

export interface PhaseItem extends ItemBase {
  kind: "phase";
  phase: RunPhase;
}

export interface SetupLogLine {
  stream: "stdout" | "stderr";
  text: string;
}

/** Consecutive `setup_log` events coalesce into one terminal block. */
export interface SetupLogItem extends ItemBase {
  kind: "setup_log";
  lines: SetupLogLine[];
}

export interface ReasoningItem extends ItemBase {
  kind: "reasoning";
  text: string;
}

export interface MessageItem extends ItemBase {
  kind: "message";
  messageId: string;
  role: "assistant" | "user";
  text: string;
  /** True only for the ephemeral delta overlay; never true for a durable row. */
  streaming: boolean;
}

/** A `tool_call` and its `tool_result`, joined on callId into one card. */
export interface ToolItem extends ItemBase {
  kind: "tool";
  callId: string;
  tool: ToolName;
  args: Record<string, unknown>;
  result: EventPayloadMap["tool_result"] | null;
}

/** The host-derived diff, verbatim. An intersection rather than an `extends`
 *  clause because the payload arrives as an indexed access on the frozen map. */
export type DiffItem = ItemBase & EventPayloadMap["diff"] & { kind: "diff" };

export interface StatusItem extends ItemBase {
  kind: "status";
  status: RunStatus;
  reason: string | null;
}

export interface ErrorItem extends ItemBase {
  kind: "error";
  code: string;
  message: string;
  retryable: boolean;
}

export type TranscriptItem =
  | PhaseItem
  | SetupLogItem
  | ReasoningItem
  | MessageItem
  | ToolItem
  | DiffItem
  | StatusItem
  | ErrorItem;

export interface TranscriptState {
  taskId: string | null;
  /** The most recent run seen. A follow-up turn is a new run (PLAN.md §4). */
  runId: string | null;
  /** Runs in first-seen order; `seq` is monotonic *within* a run, not across. */
  runOrder: readonly string[];
  /** Canonical ordering: by run, then by seq. Deduplicated. */
  events: readonly AnyEventRow[];
  /** Reconnect cursor — the `after` value to resume the socket from. */
  lastSeq: number;
  /** Highest seq the server holds, from the hello frame. Backfill is done when `lastSeq >= serverLatestSeq`. */
  serverLatestSeq: number;
  /** Ephemeral, never persisted: messageId -> accumulated token text. */
  deltas: Readonly<Record<string, string>>;
  /** messageIds whose durable `message` has landed; late deltas for these are ignored. */
  settledMessageIds: readonly string[];
  phase: RunPhase;
  status: RunStatus;
  stopReason: string | null;
  /** Convenience pointer for the diff tab: the most recent `diff` event. */
  latestDiff: DiffItem | null;
  /** Durable items only. Use `transcriptItems()` to include the delta overlay. */
  items: readonly TranscriptItem[];
}

export const initialTranscriptState: TranscriptState = {
  taskId: null,
  runId: null,
  runOrder: [],
  events: [],
  lastSeq: 0,
  serverLatestSeq: 0,
  deltas: {},
  settledMessageIds: [],
  phase: "queued",
  status: "queued",
  stopReason: null,
  latestDiff: null,
  items: [],
};

/* -------------------------------------------------------------------------- */
/* Durable fold                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The mutable slice of state that a durable event can affect. Kept separate
 * from `TranscriptState` so the incremental (append at tail) and the full
 * recompute (out-of-order arrival) paths call the exact same function, rather
 * than each maintaining its own idea of what an event means.
 */
interface Derived {
  phase: RunPhase;
  status: RunStatus;
  stopReason: string | null;
  latestDiff: DiffItem | null;
  items: TranscriptItem[];
  deltas: Record<string, string>;
  settledMessageIds: string[];
}

function itemId(ev: AnyEventRow): string {
  return `${ev.runId}:${ev.seq}`;
}

function base(ev: AnyEventRow): ItemBase {
  return { id: itemId(ev), runId: ev.runId, seq: ev.seq, at: ev.createdAt };
}

/** Folds one durable event into `d`, mutating it. Unknown types are ignored. */
function applyDurable(d: Derived, ev: AnyEventRow): void {
  switch (ev.type) {
    case "phase": {
      d.phase = ev.payload.phase;
      d.items.push({ ...base(ev), kind: "phase", phase: ev.payload.phase });
      return;
    }
    case "setup_log": {
      const line: SetupLogLine = { stream: ev.payload.stream, text: ev.payload.text };
      const last = d.items[d.items.length - 1];
      if (last && last.kind === "setup_log") {
        // Coalesce so the install output reads as one terminal block rather
        // than N stacked cards. Deterministic under both fold paths because
        // both walk the canonically ordered list. Replaced rather than mutated:
        // the incremental path shallow-copies `items`, so the previous state
        // still points at this object and must not see it change.
        d.items[d.items.length - 1] = { ...last, lines: [...last.lines, line] };
        return;
      }
      d.items.push({ ...base(ev), kind: "setup_log", lines: [line] });
      return;
    }
    case "reasoning": {
      d.items.push({ ...base(ev), kind: "reasoning", text: ev.payload.text });
      return;
    }
    case "message": {
      const { messageId, role, text } = ev.payload;
      // The durable row is truth: discard the optimistic overlay for this
      // message and remember that it has settled, so a straggling delta frame
      // arriving after the message cannot re-open it.
      delete d.deltas[messageId];
      if (!d.settledMessageIds.includes(messageId)) d.settledMessageIds.push(messageId);
      d.items.push({ ...base(ev), kind: "message", messageId, role, text, streaming: false });
      return;
    }
    case "tool_call": {
      d.items.push({
        ...base(ev),
        kind: "tool",
        callId: ev.payload.callId,
        tool: ev.payload.tool,
        args: ev.payload.args,
        result: null,
      });
      return;
    }
    case "tool_result": {
      const payload = ev.payload;
      for (let i = d.items.length - 1; i >= 0; i -= 1) {
        const item = d.items[i];
        if (item && item.kind === "tool" && item.callId === payload.callId && item.result === null) {
          d.items[i] = { ...item, result: payload };
          return;
        }
      }
      // Defensive: a result with no visible call (dropped frame, or history
      // truncated mid-call). Render the card anyway rather than swallowing it.
      d.items.push({
        ...base(ev),
        kind: "tool",
        callId: payload.callId,
        tool: payload.tool,
        args: {},
        result: payload,
      });
      return;
    }
    case "diff": {
      const item: DiffItem = { ...base(ev), kind: "diff", ...ev.payload };
      d.latestDiff = item;
      d.items.push(item);
      return;
    }
    case "status": {
      const { status, reason } = ev.payload;
      d.status = status;
      d.stopReason = reason ?? null;
      if (status !== "queued" && status !== "running") d.phase = "done";
      d.items.push({ ...base(ev), kind: "status", status, reason: reason ?? null });
      return;
    }
    case "error": {
      d.items.push({
        ...base(ev),
        kind: "error",
        code: ev.payload.code,
        message: ev.payload.message,
        retryable: ev.payload.retryable,
      });
      return;
    }
    default:
      // A newer worker may emit a type this client does not know yet. It still
      // occupies a seq, so it stays in `events` (dedupe and the reconnect
      // cursor keep working) — it simply renders nothing.
      return;
  }
}

/**
 * A fresh fold seed. `settledMessageIds` deliberately restarts empty: every
 * settled id is re-derived from the event list, so a recompute produces the
 * same array *in the same order* as an in-order fold. `deltas` are carried
 * over instead, because they exist only in memory and are not in the list.
 */
function emptyDerived(deltas: Record<string, string>): Derived {
  return {
    phase: initialTranscriptState.phase,
    status: initialTranscriptState.status,
    stopReason: null,
    latestDiff: null,
    items: [],
    deltas,
    settledMessageIds: [],
  };
}

function commit(state: TranscriptState, events: readonly AnyEventRow[], d: Derived): TranscriptState {
  const last = events[events.length - 1];
  return {
    ...state,
    events,
    runId: last ? last.runId : state.runId,
    taskId: last ? last.taskId : state.taskId,
    lastSeq: state.lastSeq,
    phase: d.phase,
    status: d.status,
    stopReason: d.stopReason,
    latestDiff: d.latestDiff,
    items: d.items,
    deltas: d.deltas,
    settledMessageIds: d.settledMessageIds,
  };
}

/* -------------------------------------------------------------------------- */
/* Ordering and dedupe                                                         */
/* -------------------------------------------------------------------------- */

function runRank(runOrder: readonly string[], runId: string): number {
  const i = runOrder.indexOf(runId);
  return i === -1 ? runOrder.length : i;
}

function isAfter(runOrder: readonly string[], a: AnyEventRow, b: AnyEventRow): boolean {
  const ra = runRank(runOrder, a.runId);
  const rb = runRank(runOrder, b.runId);
  if (ra !== rb) return ra > rb;
  return a.seq > b.seq;
}

/** Applies one durable event. Duplicates (same run + seq) are ignored outright. */
function applyEvent(state: TranscriptState, ev: AnyEventRow): TranscriptState {
  const duplicate = state.events.some((e) => e.runId === ev.runId && e.seq === ev.seq);
  if (duplicate) return state;

  const runOrder = state.runOrder.includes(ev.runId) ? state.runOrder : [...state.runOrder, ev.runId];
  const tail = state.events[state.events.length - 1];
  const lastSeq = Math.max(state.lastSeq, ev.seq);

  if (!tail || isAfter(runOrder, ev, tail)) {
    // Common case: the stream is in order, so fold incrementally.
    const d: Derived = {
      phase: state.phase,
      status: state.status,
      stopReason: state.stopReason,
      latestDiff: state.latestDiff,
      items: [...state.items],
      deltas: { ...state.deltas },
      settledMessageIds: [...state.settledMessageIds],
    };
    applyDurable(d, ev);
    return { ...commit(state, [...state.events, ev], d), runOrder, lastSeq };
  }

  // Out of order. Splice into canonical position and re-fold the whole list, so
  // the result is byte-identical to what an in-order stream would have produced.
  const events = [...state.events, ev].sort((a, b) => {
    const ra = runRank(runOrder, a.runId);
    const rb = runRank(runOrder, b.runId);
    return ra !== rb ? ra - rb : a.seq - b.seq;
  });
  const d = emptyDerived({ ...state.deltas });
  for (const e of events) applyDurable(d, e);
  return { ...commit(state, events, d), runOrder, lastSeq };
}

/* -------------------------------------------------------------------------- */
/* Delta overlay                                                               */
/* -------------------------------------------------------------------------- */

function applyDelta(state: TranscriptState, frame: DeltaFrame): TranscriptState {
  // A delta for an already-settled message is stale by definition — the
  // durable row superseded it — so it is dropped rather than re-rendered.
  if (state.settledMessageIds.includes(frame.messageId)) return state;
  const prev = state.deltas[frame.messageId] ?? "";
  return { ...state, deltas: { ...state.deltas, [frame.messageId]: prev + frame.text } };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The one reducer. Feed it live `ServerFrame`s from the socket, or history rows
 * wrapped with `eventFrame()`. There is deliberately no other way in.
 */
export function transcriptReducer(state: TranscriptState, frame: ServerFrame): TranscriptState {
  switch (frame.kind) {
    case "hello":
      // Sent once on connect, before backfill: reset so a reconnect cannot
      // leave stale items from a previous subscription lying around.
      return {
        ...initialTranscriptState,
        taskId: frame.taskId,
        runId: frame.runId,
        serverLatestSeq: frame.latestSeq,
      };
    case "event":
      return applyEvent(state, frame.event);
    case "delta":
      return applyDelta(state, frame);
    default:
      return state;
  }
}

/** Wraps a history row so it enters through the same door as a live frame. */
export function eventFrame(event: AnyEventRow): ServerFrame {
  return { kind: "event", event };
}

/**
 * Replay: fold a page of history. Identical to receiving the same rows live,
 * because it is literally the same call.
 */
export function foldEvents(
  events: Iterable<AnyEventRow>,
  from: TranscriptState = initialTranscriptState,
): TranscriptState {
  let state = from;
  for (const event of events) state = transcriptReducer(state, eventFrame(event));
  return state;
}

/**
 * Durable items plus the optimistic delta overlay, in render order.
 * The overlay is a *selector*, not stored state, so it can never be mistaken
 * for something that survived a reload.
 */
export function transcriptItems(state: TranscriptState): TranscriptItem[] {
  const streaming: MessageItem[] = [];
  for (const [messageId, text] of Object.entries(state.deltas)) {
    if (state.settledMessageIds.includes(messageId)) continue;
    streaming.push({
      id: `delta:${messageId}`,
      runId: state.runId ?? "",
      seq: state.lastSeq,
      at: "",
      kind: "message",
      messageId,
      role: "assistant",
      text,
      streaming: true,
    });
  }
  return streaming.length === 0 ? [...state.items] : [...state.items, ...streaming];
}

/** True while the client is still catching up on backfill after a connect. */
export function isBackfilling(state: TranscriptState): boolean {
  return state.serverLatestSeq > 0 && state.lastSeq < state.serverLatestSeq;
}

export function isTerminal(status: RunStatus): boolean {
  return status !== "queued" && status !== "running";
}
