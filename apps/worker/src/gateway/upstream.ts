import type { RawUsage } from "./pricing.js";

/**
 * The seam between the gateway's policy (metering, budgets, wind-down) and the
 * model provider itself.
 *
 * Splitting it out is what lets the entire gateway be tested with no network:
 * `FakeUpstream` implements this, and every budget, cost and wind-down test in
 * this directory runs offline. In production it also means swapping providers,
 * or putting a metering broker in front, is one class.
 */

export type UpstreamEvent =
  | { type: "delta"; messageId: string; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; callId: string; name: string; args: string }
  | { type: "done"; usage: RawUsage }
  | { type: "error"; message: string };

export interface UpstreamRequest {
  model: string;
  input: unknown;
  tools: unknown;
  apiKey: string;
  signal: AbortSignal;
}

export interface Upstream {
  stream(req: UpstreamRequest): AsyncIterable<UpstreamEvent>;
}
