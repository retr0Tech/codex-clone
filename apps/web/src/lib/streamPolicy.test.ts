import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnyEventRow, ServerFrame } from "@codex-clone/core";
import { eventFrame, foldEvents, initialTranscriptState, transcriptReducer } from "./eventReducer";
import {
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  advanceCursor,
  reconnectDelayMs,
  shouldResetOnHello,
} from "./streamPolicy";

function row(seq: number, text: string): AnyEventRow {
  return {
    seq,
    runId: "run_1",
    taskId: "task_1",
    type: "reasoning",
    payload: { text },
    createdAt: new Date(1_700_000_000_000 + seq).toISOString(),
  };
}

describe("hello handling", () => {
  it("resets on the first hello of a subscription", () => {
    assert.equal(shouldResetOnHello(false), true);
  });

  it("suppresses a second hello, because that one is a reconnect", () => {
    assert.equal(shouldResetOnHello(true), false);
  });

  /**
   * The bug this rule prevents, demonstrated: a reconnect asks for
   * `after=<cursor>`, so the server sends only what came after it. Feeding the
   * accompanying hello to the reducer would clear everything before the cursor
   * and leave the transcript starting in the middle.
   */
  it("dispatching a reconnect's hello would erase everything before the cursor", () => {
    const history = [row(64, "one"), row(128, "two"), row(192, "three")];
    const connected = foldEvents(history);
    assert.equal(connected.items.length, 3);

    const gap = [row(256, "four")];

    // Wrong: reset, then apply only the gap.
    let naive = transcriptReducer(connected, { kind: "hello", taskId: "task_1", runId: "run_1", latestSeq: 256 });
    for (const event of gap) naive = transcriptReducer(naive, eventFrame(event));
    assert.equal(naive.items.length, 1, "the reset threw away the backfilled history");

    // Right: suppress the hello, apply the gap on top.
    let resumed = connected;
    for (const event of gap) resumed = transcriptReducer(resumed, eventFrame(event));
    assert.equal(resumed.items.length, 4);
    assert.deepEqual(foldEvents([...history, ...gap]).items, resumed.items);
  });

  it("a first connect still resets, so switching tasks cannot inherit a transcript", () => {
    const stale = foldEvents([row(64, "from the previous task")]);
    const fresh = transcriptReducer(stale, { kind: "hello", taskId: "task_2", runId: "run_2", latestSeq: 0 });
    assert.deepEqual(fresh.items, []);
    assert.equal(fresh.taskId, "task_2");
  });
});

describe("reconnect cursor", () => {
  it("advances on event frames only", () => {
    let cursor = 0;
    cursor = advanceCursor(cursor, eventFrame(row(64, "a")));
    assert.equal(cursor, 64);

    const delta: ServerFrame = { kind: "delta", runId: "run_1", messageId: "m1", text: "tokens" };
    cursor = advanceCursor(cursor, delta);
    assert.equal(cursor, 64, "an ephemeral delta is not a resume point -- it is never replayed");

    const hello: ServerFrame = { kind: "hello", taskId: "task_1", runId: "run_1", latestSeq: 999 };
    cursor = advanceCursor(cursor, hello);
    assert.equal(cursor, 64, "the server's high-water mark is not what WE have received");
  });

  it("never moves backwards on an out-of-order frame", () => {
    let cursor = advanceCursor(0, eventFrame(row(128, "b")));
    cursor = advanceCursor(cursor, eventFrame(row(64, "a")));
    assert.equal(cursor, 128);
  });

  it("starting from the cursor, a resumed fold matches an unbroken one", () => {
    const all = [row(64, "a"), row(128, "b"), row(192, "c"), row(256, "d")];
    let cursor = 0;
    let state = initialTranscriptState;
    for (const event of all.slice(0, 2)) {
      const frame = eventFrame(event);
      cursor = advanceCursor(cursor, frame);
      state = transcriptReducer(state, frame);
    }
    // "Disconnect." The server would now send only seq > cursor.
    const gap = all.filter((event) => event.seq > cursor);
    for (const event of gap) state = transcriptReducer(state, eventFrame(event));

    assert.deepEqual(state.items, foldEvents(all).items);
    assert.equal(state.lastSeq, 256);
  });
});

describe("reconnect backoff", () => {
  it("starts fast", () => {
    assert.equal(reconnectDelayMs(1), RECONNECT_MIN_MS);
  });

  it("grows, then stops growing", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map(reconnectDelayMs);
    for (let i = 1; i < delays.length; i += 1) {
      assert.ok(delays[i]! >= delays[i - 1]!, `${delays[i]} should not be shorter than ${delays[i - 1]}`);
    }
    assert.equal(delays.at(-1), RECONNECT_MAX_MS);
    assert.ok(delays.every((d) => d <= RECONNECT_MAX_MS));
  });
});
