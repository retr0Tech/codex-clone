import type { BudgetBreach, GatewayChunk, GatewayRequest } from "@codex-clone/core";
import type { GatewayClient } from "./gateway-client.js";

/**
 * A scripted gateway with no sockets and no network.
 *
 * This is the payoff of routing model calls through a host gateway rather than
 * calling OpenAI from inside the agent: the entire loop -- tool dispatch,
 * ask-mode tool omission, wind-down on refusal, NDJSON framing -- is testable
 * offline and deterministically. The whole suite runs in CI with no key and no
 * egress.
 *
 * Not test-only scaffolding hidden in a spec file: it lives in src/ because it
 * is the reference implementation of the client contract, and it is typechecked
 * and linted alongside the real one.
 */
export class FakeGatewayClient implements GatewayClient {
  /** Every request the loop made, in order. Assert on `tools` and `input`. */
  readonly requests: GatewayRequest[] = [];
  #turns: GatewayChunk[][];

  /** One array of chunks per turn, consumed in order. */
  constructor(turns: GatewayChunk[][]) {
    this.#turns = [...turns];
  }

  get remainingTurns(): number {
    return this.#turns.length;
  }

  async *send(req: GatewayRequest): AsyncIterable<GatewayChunk> {
    // Snapshot: the loop grows one `input` array in place across turns, and a
    // record of "what was sent on turn 2" is only useful if it is a copy.
    this.requests.push(structuredClone(req));
    const turn = this.#turns.shift();
    if (!turn) {
      // A loop that asks for more turns than the test scripted is a bug in the
      // loop, and it must surface as a refusal rather than an empty stream --
      // an empty stream would look like "the model chose to stop".
      yield {
        type: "refused",
        reason: "upstream_error",
        message: "FakeGatewayClient ran out of scripted turns",
      };
      return;
    }
    for (const chunk of turn) {
      // Yield across a microtask so ordering bugs that only appear with real
      // async I/O are reproducible here.
      await Promise.resolve();
      yield chunk;
    }
  }
}

/** Convenience builders, so tests read as scripts rather than object literals. */
export const chunk = {
  delta(messageId: string, text: string): GatewayChunk {
    return { type: "delta", messageId, text };
  },
  reasoning(text: string): GatewayChunk {
    return { type: "reasoning", text };
  },
  toolCall(callId: string, name: string, args: Record<string, unknown>): GatewayChunk {
    return { type: "tool_call", callId, name, args: JSON.stringify(args) };
  },
  done(costUsd = 0.001): GatewayChunk {
    return { type: "done", usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, costUsd } };
  },
  refused(reason: BudgetBreach | "upstream_error", message: string): GatewayChunk {
    return { type: "refused", reason, message };
  },
};
