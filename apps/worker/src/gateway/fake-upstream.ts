import type { Upstream, UpstreamEvent, UpstreamRequest } from "./upstream.js";

/**
 * A model provider that never touches the network.
 *
 * With this and `FakeGatewayClient` on the agent side, the entire vertical --
 * agent loop, unix socket, budget enforcement, wind-down, cost accounting --
 * is exercised in CI with no API key and no egress. That property is the main
 * reason the model call was pushed out of the container in the first place.
 */
export class FakeUpstream implements Upstream {
  /** Every request the gateway forwarded, in order. */
  readonly requests: Array<Omit<UpstreamRequest, "signal">> = [];
  #turns: UpstreamEvent[][];

  constructor(turns: UpstreamEvent[][]) {
    this.#turns = [...turns];
  }

  /** Assert that the key the gateway attached is the one the store held. */
  get lastApiKey(): string | undefined {
    return this.requests.at(-1)?.apiKey;
  }

  async *stream(req: UpstreamRequest): AsyncIterable<UpstreamEvent> {
    const { signal: _signal, ...rest } = req;
    this.requests.push(structuredClone(rest));

    const turn = this.#turns.shift();
    if (!turn) {
      yield { type: "error", message: "FakeUpstream ran out of scripted turns" };
      return;
    }
    for (const event of turn) {
      await Promise.resolve();
      yield event;
    }
  }
}

export const upstream = {
  delta(messageId: string, text: string): UpstreamEvent {
    return { type: "delta", messageId, text };
  },
  reasoning(text: string): UpstreamEvent {
    return { type: "reasoning", text };
  },
  toolCall(callId: string, name: string, args: Record<string, unknown>): UpstreamEvent {
    return { type: "tool_call", callId, name, args: JSON.stringify(args) };
  },
  done(inputTokens = 1000, outputTokens = 200, cachedInputTokens = 0): UpstreamEvent {
    return { type: "done", usage: { inputTokens, cachedInputTokens, outputTokens } };
  },
  error(message: string): UpstreamEvent {
    return { type: "error", message };
  },
};
