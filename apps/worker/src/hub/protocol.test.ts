import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_CLIENT_FRAME_BYTES, isAllowedOrigin, parseClientFrame, parseHandshake } from "./protocol.js";

/**
 * A browser tab is not a trusted peer: any page the user has open can open a
 * WebSocket to 127.0.0.1, and the browser will not stop it. Everything the
 * socket accepts is therefore parsed rather than cast, and these are the cases
 * that must not throw inside a message handler.
 */
describe("client frame parsing", () => {
  it("accepts a subscribe frame and defaults the cursor", () => {
    const parsed = parseClientFrame(JSON.stringify({ kind: "subscribe", taskId: "task_1" }));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.frame, { kind: "subscribe", taskId: "task_1", after: 0 });
  });

  it("carries an explicit cursor through", () => {
    const parsed = parseClientFrame(JSON.stringify({ kind: "subscribe", taskId: "task_1", after: 640 }));
    assert.ok(parsed.ok);
    assert.equal(parsed.frame.kind === "subscribe" ? parsed.frame.after : -1, 640);
  });

  it("accepts a cancel frame", () => {
    const parsed = parseClientFrame(JSON.stringify({ kind: "cancel", runId: "run_1" }));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.frame, { kind: "cancel", runId: "run_1" });
  });

  for (const [name, raw] of [
    ["a non-JSON body", "not json"],
    ["a JSON array", "[]"],
    ["a JSON scalar", '"hello"'],
    ["an unknown kind", '{"kind":"drop-tables"}'],
    ["subscribe with no taskId", '{"kind":"subscribe"}'],
    ["subscribe with an empty taskId", '{"kind":"subscribe","taskId":""}'],
    ["a negative cursor", '{"kind":"subscribe","taskId":"t","after":-1}'],
    ["a non-numeric cursor", '{"kind":"subscribe","taskId":"t","after":"7"}'],
    ["cancel with no runId", '{"kind":"cancel"}'],
  ] as const) {
    it(`rejects ${name} with a reason rather than throwing`, () => {
      const parsed = parseClientFrame(raw);
      assert.equal(parsed.ok, false);
      assert.ok(!parsed.ok && parsed.reason.length > 0);
    });
  }

  it("refuses an oversized frame before parsing it", () => {
    const parsed = parseClientFrame(JSON.stringify({ kind: "subscribe", taskId: "x".repeat(MAX_CLIENT_FRAME_BYTES) }));
    assert.equal(parsed.ok, false);
    assert.match(!parsed.ok ? parsed.reason : "", /exceeds/);
  });
});

describe("handshake in the connect URL", () => {
  it("reads taskId and after", () => {
    assert.deepEqual(parseHandshake("/?taskId=task_1&after=128"), { taskId: "task_1", after: 128 });
  });

  it("defaults the cursor to zero", () => {
    assert.deepEqual(parseHandshake("/?taskId=task_1"), { taskId: "task_1", after: 0 });
  });

  it("treats a nonsense cursor as a fresh subscription rather than failing", () => {
    assert.deepEqual(parseHandshake("/?taskId=task_1&after=banana"), { taskId: "task_1", after: 0 });
    assert.deepEqual(parseHandshake("/?taskId=task_1&after=-5"), { taskId: "task_1", after: 0 });
  });

  it("returns null when there is nothing to subscribe to", () => {
    assert.equal(parseHandshake("/"), null);
    assert.equal(parseHandshake(undefined), null);
  });
});

describe("origin restriction", () => {
  /**
   * The socket binds to 127.0.0.1 and has no auth, so the only reachable
   * attacker is a page in the user's own browser. Unlike fetch, the browser
   * will happily let any site open a WebSocket to localhost.
   */
  for (const origin of ["http://localhost:3000", "http://127.0.0.1:3000", "https://localhost"]) {
    it(`allows ${origin}`, () => assert.equal(isAllowedOrigin(origin), true));
  }

  for (const origin of ["https://evil.example", "http://localhost.evil.example", "null", "http://10.0.0.5"]) {
    it(`rejects ${origin}`, () => assert.equal(isAllowedOrigin(origin), false));
  }

  it("allows a missing Origin -- that is a native client, not the threat", () => {
    assert.equal(isAllowedOrigin(undefined), true);
  });
});
