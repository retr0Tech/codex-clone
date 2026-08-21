import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptItem } from "../lib/eventReducer";
import { describeActivity } from "./ActivityStrip";

const base = { id: "i", runId: "run_1", seq: 1, at: "2026-08-21T00:00:00.000Z" };

function tool(over: Partial<Extract<TranscriptItem, { kind: "tool" }>> = {}): TranscriptItem {
  return {
    ...base,
    kind: "tool",
    callId: "c1",
    tool: "shell",
    args: {},
    result: null,
    ...over,
  } as TranscriptItem;
}

describe("describeActivity", () => {
  it("names the tool the agent is inside right now", () => {
    const { label } = describeActivity("agent", [tool({ tool: "grep" })]);
    assert.equal(label, "Running grep");
  });

  it("stops naming a tool once its result has landed", () => {
    const finished = tool({
      result: { callId: "c1", tool: "shell", ok: true, output: "", truncated: false, durationMs: 3 },
    });
    assert.equal(describeActivity("agent", [finished]).label, "Thinking");
  });

  it("reads the NEWEST tool, not the first one still open", () => {
    const done = tool({
      callId: "c1",
      result: { callId: "c1", tool: "shell", ok: true, output: "", truncated: false, durationMs: 3 },
    });
    // A finished call after an open one means the agent is no longer inside the
    // open one -- scanning from the front would report a tool that has ended.
    assert.equal(describeActivity("agent", [tool({ callId: "c0" }), done]).label, "Thinking");
  });

  it("shows a short hint from the pending call's arguments", () => {
    const { detail } = describeActivity("agent", [tool({ args: { command: "npm  test\n" } })]);
    assert.equal(detail, "npm test");
  });

  it("clamps an unbounded argument rather than reflowing the composer", () => {
    const { detail } = describeActivity("agent", [tool({ args: { command: "x".repeat(500) } })]);
    assert.ok(detail !== null && detail.length <= 72, `got ${detail?.length}`);
    assert.ok(detail?.endsWith("…"));
  });

  it("says something useful for every phase", () => {
    for (const phase of ["queued", "setup", "agent", "finalizing", "done"] as const) {
      assert.ok(describeActivity(phase, []).label.length > 0, phase);
    }
  });

  it("reports writing while the assistant message is still streaming", () => {
    const streaming: TranscriptItem = {
      ...base,
      kind: "message",
      messageId: "m1",
      role: "assistant",
      text: "part",
      streaming: true,
    };
    assert.equal(describeActivity("agent", [streaming]).label, "Writing");
  });
});
