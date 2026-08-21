import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_LINE_BYTES, NdjsonEventParser, parseEventLine } from "./ndjson.js";

const ctx = { runId: "run_1", taskId: "task_1" };

function row(seq: number, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ seq, type, payload });
}

describe("parseEventLine", () => {
  it("accepts a well-formed durable event and stamps the caller's ids", () => {
    const parsed = parseEventLine(row(3, "phase", { phase: "agent" }), ctx);
    assert.equal(parsed.seq, 3);
    assert.equal(parsed.type, "phase");
    assert.equal(parsed.runId, "run_1");
    assert.equal(parsed.taskId, "task_1");
  });

  it("ignores ids claimed by the agent -- a run may only append to its own log", () => {
    const line = JSON.stringify({
      seq: 0,
      type: "message",
      runId: "someone-elses-run",
      taskId: "someone-elses-task",
      payload: { messageId: "m1", role: "assistant", text: "hi" },
    });
    const parsed = parseEventLine(line, ctx);
    assert.equal(parsed.runId, "run_1");
    assert.equal(parsed.taskId, "task_1");
  });

  it("rejects unknown event types", () => {
    assert.throws(() => parseEventLine(row(0, "delta", { text: "x" }), ctx), /unknown durable event type/);
  });

  it("rejects a line with no numeric seq", () => {
    assert.throws(() => parseEventLine(JSON.stringify({ type: "phase", payload: {} }), ctx), /numeric seq/);
  });

  it("rejects non-JSON", () => {
    assert.throws(() => parseEventLine("not json at all", ctx), /not valid JSON/);
  });
});

describe("NdjsonEventParser", () => {
  it("reassembles lines split across chunk boundaries", () => {
    const parser = new NdjsonEventParser(ctx);
    const line = `${row(0, "reasoning", { text: "thinking" })}\n`;
    const a = line.slice(0, 11);
    const b = line.slice(11, 25);
    const c = line.slice(25);

    assert.deepEqual(parser.push(a), []);
    assert.deepEqual(parser.push(b), []);
    const out = parser.push(c);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.type, "reasoning");
  });

  it("emits several events arriving in one chunk, in order", () => {
    const parser = new NdjsonEventParser(ctx);
    const out = parser.push(
      [row(0, "phase", { phase: "setup" }), row(1, "setup_log", { stream: "stdout", text: "ok" }), ""].join("\n"),
    );
    assert.deepEqual(
      out.map((e) => e.type),
      ["phase", "setup_log"],
    );
  });

  it("surfaces a malformed line as an error event and keeps going", () => {
    const parser = new NdjsonEventParser(ctx);
    const out = parser.push(
      [row(0, "phase", { phase: "agent" }), "{ this is not json", row(1, "phase", { phase: "done" }), ""].join("\n"),
    );
    assert.equal(out.length, 3);
    assert.equal(out[0]?.type, "phase");
    assert.equal(out[1]?.type, "error");
    assert.equal(out[2]?.type, "phase");
    const payload = out[1]?.payload as { code: string; retryable: boolean };
    assert.equal(payload.code, "bad_json");
    assert.equal(payload.retryable, false);
  });

  it("gives synthesized error events a seq that cannot collide with a real one", () => {
    const parser = new NdjsonEventParser(ctx);
    const out = parser.push([row(7, "phase", { phase: "agent" }), "garbage", ""].join("\n"));
    assert.equal(out[1]?.seq, 8);
  });

  it("drops an unterminated line above the cap instead of buffering forever", () => {
    const parser = new NdjsonEventParser(ctx);
    const out = parser.push("x".repeat(MAX_LINE_BYTES + 10));
    assert.equal(out.length, 1);
    assert.equal(out[0]?.type, "error");
    assert.equal((out[0]?.payload as { code: string }).code, "line_too_long");

    // The tail of the rejected line is discarded, and the next line parses.
    const after = parser.push(`still the same line\n${row(0, "phase", { phase: "done" })}\n`);
    assert.equal(after.length, 1);
    assert.equal(after[0]?.type, "phase");
  });

  it("flush returns a trailing line with no newline", () => {
    const parser = new NdjsonEventParser(ctx);
    assert.deepEqual(parser.push(row(0, "status", { status: "succeeded" })), []);
    const out = parser.flush();
    assert.equal(out.length, 1);
    assert.equal(out[0]?.type, "status");
  });

  it("flush on a clean boundary yields nothing", () => {
    const parser = new NdjsonEventParser(ctx);
    parser.push(`${row(0, "status", { status: "succeeded" })}\n`);
    assert.deepEqual(parser.flush(), []);
  });
});
