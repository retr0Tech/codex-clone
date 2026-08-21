import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnyEventRow, ServerFrame } from "@codex-clone/core";
import { eventFrame, foldEvents, initialTranscriptState, transcriptReducer } from "./eventReducer";
import {
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  advanceCursor,
  openingHello,
  reconnectDelayMs,
  shouldDispatchServerHello,
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

describe("who owns the reset", () => {
  /**
   * The bug this rule exists to prevent, and it is not hypothetical -- it shipped
   * for one commit and emptied the transcript of a task that had eighteen events.
   *
   * The page folds history over HTTP, then connects with `after=<lastSeq>`. The
   * server's hello arrives BEFORE the backfill, and the backfill covers only
   * what comes after the cursor. Dispatching that hello therefore clears
   * everything the client just loaded and nothing refills it.
   */
  it("dispatching the server's hello would erase the history the client just folded", () => {
    const history = [row(64, "one"), row(128, "two"), row(192, "three")];
    const loaded = foldEvents(history);
    assert.equal(loaded.items.length, 3);

    // The socket now subscribes with after=192, so the server has nothing to
    // send. Its hello is the only frame that arrives.
    const serverHello: ServerFrame = { kind: "hello", taskId: "task_1", runId: "run_1", latestSeq: 192 };

    const naive = transcriptReducer(loaded, serverHello);
    assert.equal(naive.items.length, 0, "this is the bug: a full transcript, wiped");

    // Ignoring it keeps what we have, and the cursor is still correct.
    assert.equal(shouldDispatchServerHello(), false);
    assert.equal(loaded.items.length, 3);
    assert.equal(loaded.lastSeq, 192);
  });

  it("the same wipe would hit every reconnect, not just the first connect", () => {
    const connected = foldEvents([row(64, "one"), row(128, "two")]);
    const gap = [row(192, "three")];

    let resumed = connected;
    for (const event of gap) resumed = transcriptReducer(resumed, eventFrame(event));

    assert.equal(resumed.items.length, 3);
    assert.deepEqual(resumed.items, foldEvents([row(64, "one"), row(128, "two"), ...gap]).items);
  });

  /**
   * The reset still has to happen -- just from the client, at a moment when it
   * knows there is nothing worth keeping.
   */
  it("the client's own opening hello clears a previous task's transcript", () => {
    const stale = foldEvents([row(64, "from the previous task")]);
    const fresh = transcriptReducer(stale, openingHello("task_2"));
    assert.deepEqual(fresh.items, []);
    assert.equal(fresh.taskId, "task_2");
    assert.equal(fresh.lastSeq, 0, "and the cursor restarts, so history is fetched from the beginning");
  });

  it("the opening hello is a real ServerFrame, so there is still only one door into the reducer", () => {
    const frame = openingHello("task_9");
    assert.equal(frame.kind, "hello");
    assert.equal(frame.kind === "hello" ? frame.taskId : "", "task_9");
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
