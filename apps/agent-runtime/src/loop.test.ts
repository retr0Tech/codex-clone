import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Writable } from "node:stream";
import type { AnyEventRow, ToolName } from "@codex-clone/core";
import { DurableEventWriter } from "./events.js";
import { chunk, FakeGatewayClient } from "./fake-gateway.js";
import type { AgentJobSpec } from "./job-spec.js";
import { runAgentLoop } from "./loop.js";
import type { ToolDef } from "./tools/index.js";
import { buildToolRegistry, toolSchemas } from "./tools/index.js";

/**
 * The whole loop, offline. No sockets, no filesystem, no key -- which is the
 * point of putting the model call behind a host gateway in the first place.
 */

function job(over: Partial<AgentJobSpec> = {}): AgentJobSpec {
  return {
    taskId: "task_1",
    runId: "run_1",
    mode: "code",
    prompt: "add a test",
    baseSha: "abc123",
    workspacePath: "/workspace",
    model: "gpt-5",
    gatewaySocketPath: "/run/gateway.sock",
    seqStart: 0,
    maxTurns: 40,
    maxToolOutputBytes: 16 * 1024,
    ...over,
  };
}

/** Captures the exact bytes the runtime would write to the container's stdout. */
function capture(): { stream: Writable; lines: () => string[]; rows: () => AnyEventRow[] } {
  let raw = "";
  const stream = new Writable({
    write(c: Buffer | string, _enc, cb) {
      raw += typeof c === "string" ? c : c.toString("utf8");
      cb();
    },
  });
  const lines = () => raw.split("\n").filter((l) => l !== "");
  return { stream, lines, rows: () => lines().map((l) => JSON.parse(l) as AnyEventRow) };
}

function fakeTool(name: ToolName, impl: (args: Record<string, unknown>) => string): ToolDef {
  return {
    name,
    schema: { type: "function", name, description: name, parameters: { type: "object", properties: {} } },
    run: (args) => Promise.resolve({ ok: true, output: impl(args), truncated: false, exitCode: 0 }),
  };
}

describe("agent loop", () => {
  it("emits a coalesced message and finishes when the model stops calling tools", async () => {
    const out = capture();
    const gateway = new FakeGatewayClient([
      [chunk.reasoning("I should "), chunk.reasoning("just answer."), chunk.delta("m1", "All "), chunk.delta("m1", "done."), chunk.done()],
    ]);

    const result = await runAgentLoop({
      job: job(),
      gateway,
      writer: new DurableEventWriter(out.stream, { runId: "run_1", taskId: "task_1" }, 0),
      registry: new Map(),
    });

    assert.equal(result.status, "succeeded");
    assert.equal(result.turns, 1);
    const rows = out.rows();
    assert.deepEqual(
      rows.map((r) => r.type),
      ["reasoning", "message"],
    );
    assert.equal((rows[0]?.payload as { text: string }).text, "I should just answer.");
    assert.deepEqual(rows[1]?.payload, { messageId: "m1", role: "assistant", text: "All done." });
  });

  it("NEVER writes token deltas as durable events", async () => {
    const out = capture();
    const gateway = new FakeGatewayClient([
      [chunk.delta("m1", "Hel"), chunk.delta("m1", "lo"), chunk.delta("m1", " world"), chunk.done()],
    ]);

    await runAgentLoop({
      job: job(),
      gateway,
      writer: new DurableEventWriter(out.stream, { runId: "run_1", taskId: "task_1" }, 0),
      registry: new Map(),
    });

    const rows = out.rows();
    // Exactly one durable row for three deltas: the partial prefixes are an
    // ephemeral overlay and must not become transcript rows.
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.type, "message");
    assert.equal(
      rows.some((r) => (r.type as string) === "delta"),
      false,
    );
    assert.equal((rows[0]?.payload as { text: string }).text, "Hello world");
  });

  it("dispatches a tool call, emits the pair, and feeds the output back", async () => {
    const out = capture();
    const seen: Record<string, unknown>[] = [];
    const registry = new Map<ToolName, ToolDef>([
      [
        "shell",
        fakeTool("shell", (args) => {
          seen.push(args);
          return "3 tests passed";
        }),
      ],
    ]);
    const gateway = new FakeGatewayClient([
      [chunk.toolCall("call_1", "shell", { command: "npm test" }), chunk.done()],
      [chunk.delta("m1", "Tests pass."), chunk.done()],
    ]);

    const result = await runAgentLoop({
      job: job(),
      gateway,
      writer: new DurableEventWriter(out.stream, { runId: "run_1", taskId: "task_1" }, 0),
      registry,
    });

    assert.equal(result.status, "succeeded");
    assert.deepEqual(seen, [{ command: "npm test" }]);
    assert.deepEqual(
      out.rows().map((r) => r.type),
      ["tool_call", "tool_result", "message"],
    );

    const secondRequest = gateway.requests[1];
    const input = secondRequest?.input as Array<Record<string, unknown>>;
    assert.deepEqual(input.at(-2), { type: "function_call", call_id: "call_1", name: "shell", arguments: '{"command":"npm test"}' });
    assert.deepEqual(input.at(-1), { type: "function_call_output", call_id: "call_1", output: "3 tests passed" });
  });

  it("reports a tool failure as a tool_result rather than crashing the run", async () => {
    const out = capture();
    const registry = new Map<ToolName, ToolDef>([
      [
        "shell",
        {
          name: "shell",
          schema: { type: "function", name: "shell", description: "", parameters: {} },
          run: () => Promise.reject(new Error("boom")),
        },
      ],
    ]);
    const gateway = new FakeGatewayClient([
      [chunk.toolCall("call_1", "shell", {}), chunk.done()],
      [chunk.delta("m1", "recovered"), chunk.done()],
    ]);

    const result = await runAgentLoop({
      job: job(),
      gateway,
      writer: new DurableEventWriter(out.stream, { runId: "run_1", taskId: "task_1" }, 0),
      registry,
    });

    assert.equal(result.status, "succeeded");
    const toolResult = out.rows().find((r) => r.type === "tool_result");
    assert.equal((toolResult?.payload as { ok: boolean }).ok, false);
    assert.match((toolResult?.payload as { output: string }).output, /boom/);
  });

  it("answers a call to a tool it does not have, instead of dispatching it", async () => {
    const out = capture();
    const gateway = new FakeGatewayClient([
      [chunk.toolCall("call_1", "apply_patch", { patch: "..." }), chunk.done()],
      [chunk.delta("m1", "ok, I cannot write"), chunk.done()],
    ]);

    await runAgentLoop({
      job: job({ mode: "ask" }),
      gateway,
      writer: new DurableEventWriter(out.stream, { runId: "run_1", taskId: "task_1" }, 0),
      registry: buildToolRegistry("ask"),
    });

    const toolResult = out.rows().find((r) => r.type === "tool_result");
    assert.equal((toolResult?.payload as { ok: boolean }).ok, false);
    assert.match((toolResult?.payload as { output: string }).output, /unknown tool "apply_patch"/);
  });

  it("winds down on a budget refusal without another turn", async () => {
    const out = capture();
    const gateway = new FakeGatewayClient([
      [chunk.delta("m1", "Wrapping up: I finished the parser."), chunk.refused("max_cost", "run exceeded $5.00")],
      [chunk.delta("m2", "this turn must never happen"), chunk.done()],
    ]);

    const result = await runAgentLoop({
      job: job(),
      gateway,
      writer: new DurableEventWriter(out.stream, { runId: "run_1", taskId: "task_1" }, 0),
      registry: new Map(),
    });

    assert.equal(result.status, "budget_exhausted");
    assert.equal(gateway.requests.length, 1, "must not request another turn after a refusal");
    const rows = out.rows();
    // The wind-down summary the model produced is kept: it is the whole point
    // of injecting the instruction instead of hard-killing.
    assert.deepEqual(
      rows.map((r) => r.type),
      ["message", "error"],
    );
    assert.match((rows[0]?.payload as { text: string }).text, /I finished the parser/);
    assert.equal((rows[1]?.payload as { code: string }).code, "gateway_refused:max_cost");
    assert.equal((rows[1]?.payload as { retryable: boolean }).retryable, false);
  });

  it("treats an upstream failure as retryable and fails the run", async () => {
    const out = capture();
    const gateway = new FakeGatewayClient([[chunk.refused("upstream_error", "502 from api.openai.com")]]);

    const result = await runAgentLoop({
      job: job(),
      gateway,
      writer: new DurableEventWriter(out.stream, { runId: "run_1", taskId: "task_1" }, 0),
      registry: new Map(),
    });

    assert.equal(result.status, "failed");
    const err = out.rows().find((r) => r.type === "error");
    assert.equal((err?.payload as { retryable: boolean }).retryable, true);
  });

  it("stops at its own turn limit rather than looping forever", async () => {
    const out = capture();
    const registry = new Map<ToolName, ToolDef>([["shell", fakeTool("shell", () => "still working")]]);
    const gateway = new FakeGatewayClient(
      Array.from({ length: 5 }, () => [chunk.toolCall("call_x", "shell", { command: "true" }), chunk.done()]),
    );

    const result = await runAgentLoop({
      job: job({ maxTurns: 3 }),
      gateway,
      writer: new DurableEventWriter(out.stream, { runId: "run_1", taskId: "task_1" }, 0),
      registry,
    });

    assert.equal(result.status, "budget_exhausted");
    assert.equal(result.turns, 3);
    assert.equal(gateway.requests.length, 3);
    assert.equal((out.rows().at(-1)?.payload as { code: string }).code, "turn_limit");
  });

  it("stops when the host cancels", async () => {
    const out = capture();
    const controller = new AbortController();
    controller.abort();
    const gateway = new FakeGatewayClient([[chunk.done()]]);

    const result = await runAgentLoop({
      job: job(),
      gateway,
      writer: new DurableEventWriter(out.stream, { runId: "run_1", taskId: "task_1" }, 0),
      registry: new Map(),
      signal: controller.signal,
    });

    assert.equal(result.status, "cancelled");
    assert.equal(gateway.requests.length, 0);
  });
});

describe("tool list sent to the model", () => {
  it("omits apply_patch entirely in ask mode", async () => {
    const out = capture();
    const gateway = new FakeGatewayClient([[chunk.delta("m1", "hi"), chunk.done()]]);

    await runAgentLoop({
      job: job({ mode: "ask" }),
      gateway,
      writer: new DurableEventWriter(out.stream, { runId: "run_1", taskId: "task_1" }, 0),
    });

    const names = (gateway.requests[0]?.tools as Array<{ name: string }>).map((t) => t.name);
    assert.deepEqual(names.sort(), ["grep", "read_file", "shell"]);
    assert.equal(names.includes("apply_patch"), false);
  });

  it("includes apply_patch in code mode", async () => {
    const out = capture();
    const gateway = new FakeGatewayClient([[chunk.delta("m1", "hi"), chunk.done()]]);

    await runAgentLoop({
      job: job({ mode: "code" }),
      gateway,
      writer: new DurableEventWriter(out.stream, { runId: "run_1", taskId: "task_1" }, 0),
    });

    const names = (gateway.requests[0]?.tools as Array<{ name: string }>).map((t) => t.name);
    assert.deepEqual(names.sort(), ["apply_patch", "grep", "read_file", "shell"]);
  });

  it("exposes every tool as a Responses-API function definition", () => {
    for (const schema of toolSchemas(buildToolRegistry("code"))) {
      assert.equal(schema.type, "function");
      assert.equal(typeof schema.description, "string");
      assert.equal((schema.parameters as { type?: string }).type, "object");
    }
  });
});

describe("NDJSON framing on stdout", () => {
  it("writes exactly one JSON object per line, with monotonic seq from seqStart", async () => {
    const out = capture();
    const registry = new Map<ToolName, ToolDef>([
      ["shell", fakeTool("shell", () => "line one\nline two\n\nline four")],
    ]);
    const gateway = new FakeGatewayClient([
      [chunk.reasoning("think"), chunk.toolCall("c1", "shell", { command: "x" }), chunk.done()],
      [chunk.delta("m1", "multi\nline\nanswer"), chunk.done()],
    ]);

    await runAgentLoop({
      job: job(),
      gateway,
      writer: new DurableEventWriter(out.stream, { runId: "run_1", taskId: "task_1" }, 100),
      registry,
    });

    const lines = out.lines();
    // Embedded newlines in tool output and in the message must be escaped by
    // JSON.stringify, never emitted raw -- a raw newline would split one event
    // into two malformed lines on the host.
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `not one JSON object per line: ${line}`);
    }
    const rows = lines.map((l) => JSON.parse(l) as AnyEventRow);
    assert.deepEqual(
      rows.map((r) => r.seq),
      rows.map((_, i) => 100 + i),
    );
    for (const row of rows) {
      assert.equal(row.runId, "run_1");
      assert.equal(row.taskId, "task_1");
      assert.equal(typeof row.createdAt, "string");
    }
  });
});
