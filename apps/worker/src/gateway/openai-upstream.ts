import type { RawUsage } from "./pricing.js";
import type { Upstream, UpstreamEvent, UpstreamRequest } from "./upstream.js";

/**
 * The real provider call: OpenAI Responses API, server-sent events.
 *
 * This is the ONLY place in the codebase that holds an API key at request
 * time, and it is in the worker process -- never in a container, never in an
 * event payload, never in a log line.
 */

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export interface OpenAiUpstreamOptions {
  url?: string;
  /** Longest the whole streamed response may take before we give up. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OpenAiUpstream implements Upstream {
  constructor(private readonly options: OpenAiUpstreamOptions = {}) {}

  async *stream(req: UpstreamRequest): AsyncIterable<UpstreamEvent> {
    const url = this.options.url ?? OPENAI_RESPONSES_URL;
    const doFetch = this.options.fetchImpl ?? fetch;
    const timeoutMs = this.options.requestTimeoutMs ?? 10 * 60 * 1000;

    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([req.signal, timeout]);

    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          // The credential is attached HERE and nowhere upstream of here.
          authorization: `Bearer ${req.apiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({ model: req.model, input: req.input, tools: req.tools, stream: true }),
        signal,
      });
    } catch (err) {
      yield { type: "error", message: describeFetchError(err, timeoutMs) };
      return;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Never echo the request back: it would put the Authorization header in
      // reach of the transcript. Status plus the provider's message only.
      yield { type: "error", message: `upstream returned ${res.status}: ${summarise(body)}` };
      return;
    }
    if (!res.body) {
      yield { type: "error", message: "upstream returned no response body" };
      return;
    }

    try {
      yield* parseSse(res.body);
    } catch (err) {
      yield { type: "error", message: describeFetchError(err, timeoutMs) };
    }
  }
}

/**
 * Server-sent events -> UpstreamEvent.
 *
 * Only the fields we actually use are read, and anything unrecognised is
 * ignored rather than throwing: the Responses API adds event types over time,
 * and a new one must not take down a run.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<UpstreamEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;

  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trimEnd();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;

      const data = line.slice(5).trim();
      if (data === "" || data === "[DONE]") continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const event = mapEvent(parsed);
      if (event) {
        if (event.type === "done") sawDone = true;
        yield event;
      }
    }
  }

  if (!sawDone) {
    // The stream closed without response.completed. Treat it as a failure
    // rather than a successful empty turn: silently succeeding here would let
    // a truncated response look like "the model chose to stop".
    yield { type: "error", message: "upstream stream ended before the response completed" };
  }
}

function mapEvent(parsed: unknown): UpstreamEvent | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const e = parsed as Record<string, unknown>;
  const type = typeof e["type"] === "string" ? (e["type"] as string) : "";

  switch (type) {
    case "response.output_text.delta": {
      const text = str(e["delta"]);
      return text === null ? null : { type: "delta", messageId: str(e["item_id"]) ?? "msg", text };
    }
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta": {
      const text = str(e["delta"]);
      return text === null ? null : { type: "reasoning", text };
    }
    case "response.output_item.done": {
      const item = e["item"];
      if (typeof item !== "object" || item === null) return null;
      const i = item as Record<string, unknown>;
      if (i["type"] !== "function_call") return null;
      return {
        type: "tool_call",
        callId: str(i["call_id"]) ?? str(i["id"]) ?? "call",
        name: str(i["name"]) ?? "",
        args: str(i["arguments"]) ?? "{}",
      };
    }
    case "response.completed": {
      return { type: "done", usage: readUsage(e["response"]) };
    }
    case "response.failed":
    case "response.incomplete": {
      const response = e["response"];
      const detail =
        typeof response === "object" && response !== null
          ? (str((response as Record<string, unknown>)["error"]) ??
            str(((response as Record<string, unknown>)["error"] as Record<string, unknown> | undefined)?.["message"]) ??
            type)
          : type;
      return { type: "error", message: `upstream ${type}: ${detail}` };
    }
    case "error": {
      return { type: "error", message: str(e["message"]) ?? "upstream error" };
    }
    default:
      return null;
  }
}

function readUsage(response: unknown): RawUsage {
  const empty: RawUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  if (typeof response !== "object" || response === null) return empty;
  const usage = (response as Record<string, unknown>)["usage"];
  if (typeof usage !== "object" || usage === null) return empty;
  const u = usage as Record<string, unknown>;
  const details = (u["input_tokens_details"] ?? {}) as Record<string, unknown>;
  return {
    inputTokens: num(u["input_tokens"]),
    cachedInputTokens: num(details["cached_tokens"]),
    outputTokens: num(u["output_tokens"]),
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function summarise(body: string): string {
  const trimmed = body.trim();
  return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 500)}...`;
}

function describeFetchError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return `upstream request aborted after ${timeoutMs}ms`;
  }
  return `upstream request failed: ${err instanceof Error ? err.message : String(err)}`;
}
