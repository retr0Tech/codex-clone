import type { DurableEventType, EventPayloadMap } from "@codex-clone/core";

/**
 * stdout is the durable event log. Nothing else may write to it.
 *
 * The critical invariant (PLAN.md section 3.6): token deltas are EPHEMERAL.
 * They exist so the browser can render text as it arrives; they are an
 * optimistic overlay that the coalesced `message` event supersedes. If a delta
 * were ever written here it would become a persisted row, the transcript would
 * contain every partial prefix of every sentence, and live and replayed views
 * would diverge -- which is the exact drift the shared shape exists to prevent.
 *
 * `emit` is typed against the frozen `EventPayloadMap`, so "delta" is not a
 * value this class can be asked to write.
 */
export class DurableEventWriter {
  #seq: number;

  constructor(
    private readonly out: NodeJS.WritableStream,
    private readonly ids: { runId: string; taskId: string },
    seqStart = 0,
  ) {
    this.#seq = seqStart;
  }

  get nextSeq(): number {
    return this.#seq;
  }

  emit<T extends DurableEventType>(type: T, payload: EventPayloadMap[T]): void {
    const row = {
      seq: this.#seq++,
      runId: this.ids.runId,
      taskId: this.ids.taskId,
      type,
      payload,
      createdAt: new Date().toISOString(),
    };
    this.out.write(`${JSON.stringify(row)}\n`);
  }
}

/**
 * Diagnostics go to stderr, always. A stray console.log would be parsed by the
 * host as a malformed event line.
 */
export function log(message: string): void {
  process.stderr.write(`[agent] ${message}\n`);
}
