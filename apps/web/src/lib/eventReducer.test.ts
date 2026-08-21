/**
 * The invariant these tests exist to protect: **live and replayed transcripts
 * cannot drift**, because they are the same reducer over the same rows.
 *
 * That claim is only worth making if it is enforced, so the first test folds
 * every fixture run twice — once as a live frame stream with token deltas
 * interleaved, once as replayed history — and asserts the two states are
 * deeply equal. The rest cover the ways a real socket misbehaves: duplicate
 * backfill after a reconnect, out-of-order frames, deltas that arrive late,
 * and event types this client has never heard of.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnyEventRow, DeltaFrame, ServerFrame } from "@codex-clone/core";
import {
  eventFrame,
  foldEvents,
  initialTranscriptState,
  isBackfilling,
  transcriptItems,
  transcriptReducer,
  type MessageItem,
  type SetupLogItem,
  type ToolItem,
  type TranscriptState,
} from "./eventReducer";
import { historyForTask, mockRuns } from "../mocks/runs";

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function play(frames: ServerFrame[], from: TranscriptState = initialTranscriptState): TranscriptState {
  return frames.reduce(transcriptReducer, from);
}

/** Deterministic shuffle, so a failure is reproducible rather than "sometimes". */
function shuffle<T>(input: readonly T[], seed: number): T[] {
  const out = [...input];
  let s = seed;
  const next = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

const RUN = "run_test";
const TASK = "task_test";

function row(seq: number, partial: Partial<AnyEventRow> & Pick<AnyEventRow, "type" | "payload">): AnyEventRow {
  return {
    seq,
    runId: RUN,
    taskId: TASK,
    createdAt: new Date(Date.UTC(2026, 7, 20, 0, 0, seq)).toISOString(),
    ...partial,
  } as AnyEventRow;
}

/* -------------------------------------------------------------------------- */
/* 1. The invariant                                                            */
/* -------------------------------------------------------------------------- */

describe("fold-then-replay equivalence", () => {
  for (const run of mockRuns) {
    it(`live stream === replayed history for ${run.id} (${run.label})`, () => {
      // Live: every frame the socket would deliver, deltas included.
      const live = play(run.frames.map((f) => f.frame));
      // Replay: only what the events table holds. Deltas are never persisted.
      const replayed = foldEvents(run.events);

      assert.deepStrictEqual(
        live,
        replayed,
        "a reload must reconstruct byte-identical state; if this fails the transport's whole premise is broken",
      );
      // And the overlay left nothing behind.
      assert.deepStrictEqual(live.deltas, {});
      assert.ok(transcriptItems(live).every((i) => i.kind !== "message" || !i.streaming));
    });
  }

  it("holds across a multi-run task where seq restarts per run", () => {
    const history = historyForTask("task_rate_limit");
    const seqs = history.map((e) => e.seq);
    // Precondition for the test to mean anything: seq is not globally unique.
    assert.ok(new Set(seqs).size < seqs.length, "fixture should contain repeated seq values across runs");

    const runs = mockRuns.filter((r) => r.taskId === "task_rate_limit");
    const live = play(runs.flatMap((r) => r.frames.map((f) => f.frame)));
    const replayed = foldEvents(history);

    assert.deepStrictEqual(live, replayed);
    assert.equal(live.runOrder.length, 2);
    // Ordering is by run, then seq — not by seq alone, which would interleave.
    assert.deepStrictEqual(
      live.events.map((e) => e.runId),
      [...runs[0]!.events.map(() => runs[0]!.id), ...runs[1]!.events.map(() => runs[1]!.id)],
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Arrival order                                                            */
/* -------------------------------------------------------------------------- */

describe("out-of-order arrival", () => {
  for (const seed of [1, 7, 4242]) {
    it(`shuffled arrival (seed ${seed}) folds to the in-order state`, () => {
      const run = mockRuns[0]!;
      const ordered = foldEvents(run.events);
      const jumbled = foldEvents(shuffle(run.events, seed));
      assert.deepStrictEqual(jumbled, ordered);
    });
  }

  it("reversed arrival folds to the in-order state", () => {
    const run = mockRuns[2]!;
    assert.deepStrictEqual(foldEvents([...run.events].reverse()), foldEvents(run.events));
  });

  it("keeps lastSeq at the high-water mark even when an older frame lands after it", () => {
    let s = foldEvents([row(1, { type: "phase", payload: { phase: "setup" } })]);
    s = transcriptReducer(s, eventFrame(row(5, { type: "phase", payload: { phase: "agent" } })));
    assert.equal(s.lastSeq, 5);
    s = transcriptReducer(s, eventFrame(row(3, { type: "reasoning", payload: { text: "late" } })));
    assert.equal(s.lastSeq, 5, "the cursor must not go backwards, or a reconnect would replay forever");
    // ...and the late event still sorts into its rightful place.
    assert.deepStrictEqual(s.items.map((i) => i.seq), [1, 3, 5]);
    assert.equal(s.phase, "agent");
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Duplicates                                                               */
/* -------------------------------------------------------------------------- */

describe("duplicate seq", () => {
  it("is idempotent when the whole stream is delivered twice", () => {
    const run = mockRuns[0]!;
    const once = foldEvents(run.events);
    const twice = foldEvents(run.events, once);
    assert.deepStrictEqual(twice, once);
  });

  it("survives a reconnect that backfills from a stale cursor", () => {
    // The realistic case: the client resumes from `after = lastSeq - 3`, so the
    // server re-sends three events it already has.
    const run = mockRuns[0]!;
    const full = foldEvents(run.events);
    const cut = run.events.length - 3;
    const partial = foldEvents(run.events.slice(0, cut));
    const resumed = foldEvents(run.events.slice(cut - 3), partial);
    assert.deepStrictEqual(resumed, full);
  });

  it("keeps the first copy when a duplicate seq carries a different payload", () => {
    const s = foldEvents([
      row(1, { type: "reasoning", payload: { text: "first" } }),
      row(1, { type: "reasoning", payload: { text: "second" } }),
    ]);
    assert.equal(s.items.length, 1);
    assert.equal(s.events.length, 1);
    assert.equal((s.items[0] as { text: string }).text, "first");
  });

  it("does not confuse the same seq in two different runs", () => {
    const a = row(1, { type: "reasoning", payload: { text: "run a" } });
    const b = { ...row(1, { type: "reasoning", payload: { text: "run b" } }), runId: "run_other" } as AnyEventRow;
    const s = foldEvents([a, b]);
    assert.equal(s.events.length, 2);
    assert.deepStrictEqual(s.runOrder, [RUN, "run_other"]);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. The delta overlay                                                        */
/* -------------------------------------------------------------------------- */

describe("delta overlay", () => {
  const delta = (messageId: string, text: string): DeltaFrame => ({
    kind: "delta",
    runId: RUN,
    messageId,
    text,
  });

  it("accumulates tokens into a streaming item that is not durable state", () => {
    let s = play([delta("m1", "Look"), delta("m1", "ing at "), delta("m1", "the router")]);
    assert.deepStrictEqual(s.items, [], "deltas must never enter the durable item list");
    const items = transcriptItems(s);
    assert.equal(items.length, 1);
    const msg = items[0] as MessageItem;
    assert.equal(msg.kind, "message");
    assert.equal(msg.streaming, true);
    assert.equal(msg.text, "Looking at the router");

    // ...and it settles into the durable message the moment that arrives.
    s = transcriptReducer(
      s,
      eventFrame(row(1, { type: "message", payload: { messageId: "m1", role: "assistant", text: "Looking at the router." } })),
    );
    assert.deepStrictEqual(s.deltas, {}, "the overlay must be discarded, not merged");
    const settled = transcriptItems(s);
    assert.equal(settled.length, 1);
    assert.equal((settled[0] as MessageItem).streaming, false);
    assert.equal((settled[0] as MessageItem).text, "Looking at the router.");
  });

  it("ignores a delta that arrives after its durable message", () => {
    let s = play([
      eventFrame(row(1, { type: "message", payload: { messageId: "m1", role: "assistant", text: "final" } })),
      delta("m1", " straggler"),
    ]);
    assert.deepStrictEqual(s.deltas, {});
    assert.equal(transcriptItems(s).length, 1);
    assert.equal((transcriptItems(s)[0] as MessageItem).text, "final");

    // Even a whole burst of stragglers changes nothing.
    s = play([delta("m1", "a"), delta("m1", "b")], s);
    assert.equal((transcriptItems(s)[0] as MessageItem).text, "final");
  });

  it("keeps a second in-flight message separate from a settled one", () => {
    const s = play([
      eventFrame(row(1, { type: "message", payload: { messageId: "m1", role: "assistant", text: "one" } })),
      delta("m2", "two-in-"),
      delta("m2", "flight"),
    ]);
    const items = transcriptItems(s);
    assert.equal(items.length, 2);
    assert.equal((items[0] as MessageItem).streaming, false);
    assert.equal((items[1] as MessageItem).streaming, true);
    assert.equal((items[1] as MessageItem).text, "two-in-flight");
  });

  it("leaves the durable fold untouched, so replay is unaffected by deltas", () => {
    const events = [row(1, { type: "message", payload: { messageId: "m1", role: "assistant", text: "final" } })];
    const withDeltas = play([delta("m1", "fin"), delta("m1", "al"), eventFrame(events[0]!)]);
    assert.deepStrictEqual(withDeltas, foldEvents(events));
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Unknown and malformed input                                              */
/* -------------------------------------------------------------------------- */

describe("forward compatibility", () => {
  it("ignores an unknown event type but still counts its seq", () => {
    const unknown = {
      seq: 2,
      runId: RUN,
      taskId: TASK,
      type: "sandbox_metrics",
      payload: { cpu: 0.4 },
      createdAt: "2026-08-20T00:00:02.000Z",
    } as unknown as AnyEventRow;

    const s = foldEvents([
      row(1, { type: "phase", payload: { phase: "agent" } }),
      unknown,
      row(3, { type: "reasoning", payload: { text: "still here" } }),
    ]);

    assert.equal(s.items.length, 2, "the unknown event renders nothing");
    assert.equal(s.events.length, 3, "but it stays in the log");
    assert.equal(s.lastSeq, 3, "and the reconnect cursor moves past it");
  });

  it("ignores an unknown frame kind", () => {
    const before = foldEvents([row(1, { type: "phase", payload: { phase: "agent" } })]);
    const after = transcriptReducer(before, { kind: "pong" } as unknown as ServerFrame);
    assert.equal(after, before);
  });

  it("renders a tool_result whose tool_call never arrived", () => {
    const s = foldEvents([
      row(1, {
        type: "tool_result",
        payload: { callId: "orphan", tool: "shell", ok: false, output: "boom", truncated: false, exitCode: 2, durationMs: 12 },
      }),
    ]);
    const item = s.items[0] as ToolItem;
    assert.equal(item.kind, "tool");
    assert.equal(item.callId, "orphan");
    assert.deepStrictEqual(item.args, {});
    assert.equal(item.result?.exitCode, 2);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Item shaping                                                             */
/* -------------------------------------------------------------------------- */

describe("item shaping", () => {
  it("joins tool_result onto its tool_call by callId", () => {
    const s = foldEvents([
      row(1, { type: "tool_call", payload: { callId: "c1", tool: "shell", args: { command: "ls" } } }),
      row(2, { type: "tool_call", payload: { callId: "c2", tool: "grep", args: { pattern: "x" } } }),
      row(3, { type: "tool_result", payload: { callId: "c2", tool: "grep", ok: true, output: "hit", truncated: false, exitCode: 0, durationMs: 9 } }),
    ]);
    assert.equal(s.items.length, 2, "a result must fold into its call rather than become a third card");
    assert.equal((s.items[0] as ToolItem).result, null);
    assert.equal((s.items[1] as ToolItem).result?.output, "hit");
  });

  it("coalesces consecutive setup_log events into one terminal block", () => {
    const s = foldEvents([
      row(1, { type: "phase", payload: { phase: "setup" } }),
      row(2, { type: "setup_log", payload: { stream: "stdout", text: "line one" } }),
      row(3, { type: "setup_log", payload: { stream: "stderr", text: "line two" } }),
      row(4, { type: "setup_log", payload: { stream: "stdout", text: "line three" } }),
      row(5, { type: "phase", payload: { phase: "agent" } }),
    ]);
    assert.deepStrictEqual(s.items.map((i) => i.kind), ["phase", "setup_log", "phase"]);
    const block = s.items[1] as SetupLogItem;
    assert.equal(block.lines.length, 3);
    assert.deepStrictEqual(block.lines[1], { stream: "stderr", text: "line two" });
  });

  it("tracks phase, terminal status and the stop reason", () => {
    const s = foldEvents([
      row(1, { type: "phase", payload: { phase: "setup" } }),
      row(2, { type: "phase", payload: { phase: "agent" } }),
      row(3, { type: "status", payload: { status: "budget_exhausted", reason: "maxCostUSD $5.00 exhausted" } }),
    ]);
    assert.equal(s.status, "budget_exhausted");
    assert.equal(s.stopReason, "maxCostUSD $5.00 exhausted");
    assert.equal(s.phase, "done", "a terminal status ends the run regardless of the last phase event");
  });

  it("points latestDiff at the most recent diff", () => {
    const s = foldEvents(historyForTask("task_rate_limit"));
    assert.ok(s.latestDiff);
    assert.equal(s.latestDiff?.files.length, 4, "the follow-up turn's diff supersedes the first");
    assert.equal(s.latestDiff?.truncated, true);
  });

  it("gives every item a stable id across folds", () => {
    const run = mockRuns[0]!;
    const a = foldEvents(run.events).items.map((i) => i.id);
    const b = foldEvents(shuffle(run.events, 99)).items.map((i) => i.id);
    assert.deepStrictEqual(a, b);
    assert.equal(new Set(a).size, a.length, "ids must be unique or React keys collide");
  });
});

/* -------------------------------------------------------------------------- */
/* 7. Connection lifecycle                                                     */
/* -------------------------------------------------------------------------- */

describe("hello frame", () => {
  it("resets state so a reconnect cannot inherit a previous subscription", () => {
    const dirty = foldEvents(mockRuns[0]!.events);
    const s = transcriptReducer(dirty, { kind: "hello", taskId: "task_other", runId: "run_other", latestSeq: 12 });
    assert.deepStrictEqual(s.items, []);
    assert.deepStrictEqual(s.events, []);
    assert.equal(s.lastSeq, 0);
    assert.equal(s.taskId, "task_other");
    assert.equal(s.serverLatestSeq, 12);
  });

  it("reports backfilling until the cursor catches the server's high-water mark", () => {
    let s = transcriptReducer(initialTranscriptState, { kind: "hello", taskId: TASK, runId: RUN, latestSeq: 2 });
    assert.equal(isBackfilling(s), true);
    s = transcriptReducer(s, eventFrame(row(1, { type: "phase", payload: { phase: "setup" } })));
    assert.equal(isBackfilling(s), true);
    s = transcriptReducer(s, eventFrame(row(2, { type: "phase", payload: { phase: "agent" } })));
    assert.equal(isBackfilling(s), false);
  });
});

/* -------------------------------------------------------------------------- */
/* 8. Purity                                                                   */
/* -------------------------------------------------------------------------- */

describe("purity", () => {
  it("never mutates the state it is given", () => {
    const run = mockRuns[0]!;
    const before = foldEvents(run.events.slice(0, 5));
    const snapshot = structuredClone(before);
    foldEvents(run.events.slice(5), before);
    assert.deepStrictEqual(before, snapshot);
  });

  it("never mutates the event rows it is given", () => {
    const run = mockRuns[2]!;
    const snapshot = structuredClone(run.events);
    foldEvents(shuffle(run.events, 5));
    assert.deepStrictEqual(run.events, snapshot);
  });
});
