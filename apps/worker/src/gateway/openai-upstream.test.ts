import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenAiUpstream, parseSse } from "./openai-upstream.js";
import type { UpstreamEvent } from "./upstream.js";

/**
 * The Responses API mapping, driven by canned SSE bytes. No network: the
 * fetch implementation is injected.
 */

function sse(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        controller.enqueue(encoder.encode(`event: x\ndata: ${JSON.stringify(e)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<UpstreamEvent[]> {
  const out: UpstreamEvent[] = [];
  for await (const e of parseSse(stream)) out.push(e);
  return out;
}

const completed = {
  type: "response.completed",
  response: {
    usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 200 }, output_tokens: 350 },
  },
};

describe("Responses API SSE mapping", () => {
  it("maps text deltas, reasoning, tool calls and usage", async () => {
    const events = await drain(
      sse([
        { type: "response.reasoning_summary_text.delta", delta: "considering" },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "Hel" },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "lo" },
        {
          type: "response.output_item.done",
          item: { type: "function_call", call_id: "call_1", name: "shell", arguments: '{"command":"ls"}' },
        },
        completed,
      ]),
    );

    assert.deepEqual(
      events.map((e) => e.type),
      ["reasoning", "delta", "delta", "tool_call", "done"],
    );
    assert.equal(events[1]?.type === "delta" && events[1].messageId, "msg_1");
    assert.equal(events[3]?.type === "tool_call" && events[3].name, "shell");
    assert.deepEqual(events[4]?.type === "done" && events[4].usage, {
      inputTokens: 1200,
      cachedInputTokens: 200,
      outputTokens: 350,
    });
  });

  it("ignores output items that are not function calls", async () => {
    const events = await drain(
      sse([{ type: "response.output_item.done", item: { type: "message", id: "m1" } }, completed]),
    );
    assert.deepEqual(
      events.map((e) => e.type),
      ["done"],
    );
  });

  it("ignores event types it has never seen, so a new API event cannot kill a run", async () => {
    const events = await drain(sse([{ type: "response.some_future_event", data: 1 }, completed]));
    assert.deepEqual(
      events.map((e) => e.type),
      ["done"],
    );
  });

  it("reports response.failed as an error", async () => {
    const events = await drain(sse([{ type: "response.failed", response: { error: { message: "rate limited" } } }]));
    assert.equal(events[0]?.type, "error");
    assert.match(events[0]?.type === "error" ? events[0].message : "", /rate limited/);
  });

  it("treats a stream that ends before completion as an error, not an empty success", async () => {
    const events = await drain(sse([{ type: "response.output_text.delta", item_id: "m1", delta: "half" }]));
    assert.equal(events.at(-1)?.type, "error");
    assert.match(events.at(-1)?.type === "error" ? (events.at(-1) as { message: string }).message : "", /ended before/);
  });

  it("survives an SSE frame split across network chunks", async () => {
    const encoder = new TextEncoder();
    const line = `data: ${JSON.stringify(completed)}\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(line.slice(0, 15)));
        controller.enqueue(encoder.encode(line.slice(15)));
        controller.close();
      },
    });
    const events = await drain(stream);
    assert.equal(events[0]?.type, "done");
  });

  it("defaults usage to zero when the provider omits it", async () => {
    const events = await drain(sse([{ type: "response.completed", response: {} }]));
    assert.deepEqual(events[0]?.type === "done" && events[0].usage, {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe("OpenAiUpstream", () => {
  it("attaches the key as a bearer token and asks for a stream", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const up = new OpenAiUpstream({
      fetchImpl: ((url: string, init: RequestInit) => {
        seen = { url, init };
        return Promise.resolve(new Response(sse([completed]), { status: 200 }));
      }) as unknown as typeof fetch,
    });

    const events: UpstreamEvent[] = [];
    for await (const e of up.stream({
      model: "gpt-5",
      input: [{ role: "user", content: "hi" }],
      tools: [],
      apiKey: "sk-test-not-a-real-key",
      signal: new AbortController().signal,
    })) {
      events.push(e);
    }

    assert.equal(events[0]?.type, "done");
    const captured = seen as unknown as { url: string; init: RequestInit };
    assert.equal(captured.url, "https://api.openai.com/v1/responses");
    assert.equal((captured.init.headers as Record<string, string>)["authorization"], "Bearer sk-test-not-a-real-key");
    assert.equal(JSON.parse(String(captured.init.body)).stream, true);
  });

  it("reports a non-2xx as an error without echoing the request", async () => {
    const up = new OpenAiUpstream({
      fetchImpl: (() => Promise.resolve(new Response("insufficient_quota", { status: 429 }))) as unknown as typeof fetch,
    });

    const events: UpstreamEvent[] = [];
    for await (const e of up.stream({
      model: "gpt-5",
      input: [],
      tools: [],
      apiKey: "sk-test-not-a-real-key",
      signal: new AbortController().signal,
    })) {
      events.push(e);
    }

    assert.equal(events[0]?.type, "error");
    const message = events[0]?.type === "error" ? events[0].message : "";
    assert.match(message, /429/);
    assert.match(message, /insufficient_quota/);
    assert.equal(message.includes("sk-test-not-a-real-key"), false, "the key must never appear in an error message");
  });

  it("reports a transport failure as an error rather than throwing", async () => {
    const up = new OpenAiUpstream({
      fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
    });

    const events: UpstreamEvent[] = [];
    for await (const e of up.stream({
      model: "gpt-5",
      input: [],
      tools: [],
      apiKey: "sk-test-not-a-real-key",
      signal: new AbortController().signal,
    })) {
      events.push(e);
    }
    assert.equal(events[0]?.type, "error");
    assert.match(events[0]?.type === "error" ? events[0].message : "", /ECONNREFUSED/);
  });
});
