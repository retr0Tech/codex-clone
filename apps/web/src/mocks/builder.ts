/**
 * Fixture builder.
 *
 * There is no backend yet (waves A and B are building it), so the UI is driven
 * entirely by these fixtures. The important property is that a fixture is not a
 * bespoke "UI mock" shape: it is a list of real `EventRow`s plus the ephemeral
 * `DeltaFrame`s that would have ridden the socket alongside them. The mock
 * player therefore exercises exactly the code path the WebSocket will, and
 * swapping the fixture for a live socket is a change of source, not of shape.
 */

import type {
  AnyEventRow,
  DeltaFrame,
  DurableEventType,
  EventPayloadMap,
  ServerFrame,
} from "@codex-clone/core";

/** One frame plus the gap that should precede it during playback. */
export interface PlaybackFrame {
  delayMs: number;
  frame: ServerFrame;
}

export class RunBuilder {
  private seq = 0;
  private clock: number;
  readonly events: AnyEventRow[] = [];
  readonly frames: PlaybackFrame[] = [];

  constructor(
    readonly runId: string,
    readonly taskId: string,
    startedAt = "2026-08-19T09:14:02.000Z",
  ) {
    this.clock = Date.parse(startedAt);
  }

  private tick(ms: number): string {
    this.clock += ms;
    return new Date(this.clock).toISOString();
  }

  /** Append a durable event. It lands in both the history list and the script. */
  event<T extends DurableEventType>(type: T, payload: EventPayloadMap[T], gapMs = 420): this {
    this.seq += 1;
    // The generic row is structurally one member of AnyEventRow; TypeScript
    // cannot prove that for an unresolved T, hence the single assertion here
    // rather than a local redefinition of the event shapes.
    const row = {
      seq: this.seq,
      runId: this.runId,
      taskId: this.taskId,
      type,
      payload,
      createdAt: this.tick(gapMs),
    } as AnyEventRow;
    this.events.push(row);
    this.frames.push({ delayMs: gapMs, frame: { kind: "event", event: row } });
    return this;
  }

  /** Append an ephemeral token delta. Never enters `events` — it is not persisted. */
  delta(messageId: string, text: string, gapMs = 28): this {
    const frame: DeltaFrame = { kind: "delta", runId: this.runId, messageId, text };
    this.frames.push({ delayMs: gapMs, frame });
    return this;
  }

  /**
   * Stream a message the way the worker will: token deltas first, then the
   * coalesced durable `message` that supersedes them.
   */
  say(
    messageId: string,
    role: "assistant" | "user",
    text: string,
    opts: { chunk?: number; gapMs?: number } = {},
  ): this {
    const chunk = opts.chunk ?? 14;
    const gapMs = opts.gapMs ?? 26;
    if (role === "assistant") {
      for (let i = 0; i < text.length; i += chunk) {
        this.delta(messageId, text.slice(i, i + chunk), gapMs);
      }
    }
    return this.event("message", { messageId, role, text }, 260);
  }

  /** A tool call and its result, as the two events they really are. */
  tool(
    callId: string,
    tool: EventPayloadMap["tool_call"]["tool"],
    args: Record<string, unknown>,
    result: Omit<EventPayloadMap["tool_result"], "callId" | "tool">,
  ): this {
    this.event("tool_call", { callId, tool, args }, 520);
    this.event("tool_result", { callId, tool, ...result }, Math.min(result.durationMs, 1400));
    return this;
  }

  /** Multiple setup lines in one go, so install output streams line by line. */
  setup(lines: Array<[stream: "stdout" | "stderr", text: string]>, gapMs = 130): this {
    for (const [stream, text] of lines) this.event("setup_log", { stream, text }, gapMs);
    return this;
  }
}
