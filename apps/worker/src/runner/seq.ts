/**
 * Sequence numbers for the event log.
 *
 * Two producers write into one transcript: the agent inside the container, and
 * the host (which contributes the workspace-preparation log, the derived diff,
 * and the terminal status). `AgentJobSpec` says the host "remains free to
 * renumber on ingest", and this is where that happens.
 *
 * Three properties have to hold at once, and a naive counter gives you at most
 * two of them:
 *
 *  1. **Monotonic per task, not just per run.** The reducer's reconnect cursor
 *     is `max(seq)` across everything it has seen, so if a follow-up run
 *     restarted at 0 a reconnect with `after=<cursor>` would silently skip the
 *     whole second run. Each run therefore starts above every seq the task has
 *     already used.
 *
 *  2. **Interleavable.** The host must be able to slot a `diff` in between two
 *     agent events, so agent seqs are spread on a stride and the gaps belong to
 *     the host.
 *
 *  3. **Replay-stable.** `DockerSandbox.attach()` follows the container log
 *     with no `tail`, so a worker that restarts mid-run re-reads the stream
 *     from the beginning. Ingesting the same agent event must produce the same
 *     stored seq every time, or the second pass writes a duplicate transcript
 *     under different numbers. The mapping here depends only on the agent's own
 *     seq and the run's base -- never on wall-clock, arrival order, or how many
 *     events this process happens to have seen -- so the replayed rows collide
 *     with the originals on `events_run_seq_idx` and are dropped by
 *     `onConflictDoNothing`.
 */

/**
 * Agent events land on multiples of this; the addresses in between are the
 * host's. Sixty-three host events per agent event is far beyond what the host
 * has to say (at most a diff and a status), and the assertion below turns any
 * future overrun into a loud failure rather than a silent seq collision.
 */
export const SEQ_STRIDE = 64;

export class SeqOverflowError extends Error {
  constructor(base: number, agentSeq: number, emitted: number) {
    super(
      `the host emitted ${emitted} events in the gap after agent seq ${agentSeq} ` +
        `(run base ${base}), which is more than the stride of ${SEQ_STRIDE} allows. ` +
        `Raise SEQ_STRIDE or emit fewer host events per agent event.`,
    );
    this.name = "SeqOverflowError";
  }
}

export class SeqAllocator {
  /** Highest seq allocated so far. Starts at the run's base. */
  #cursor: number;
  /** Host events emitted since the last agent event, for the gap check. */
  #hostSinceAgent = 0;
  #lastAgentSeq = -1;

  /**
   * @param base The highest seq already used by EARLIER runs of this task,
   * rounded up to a stride boundary by `runBase()`. Zero for a task's first
   * run.
   */
  constructor(private readonly base = 0) {
    this.#cursor = base;
  }

  get cursor(): number {
    return this.#cursor;
  }

  /**
   * Maps an agent-reported seq into the task's numbering. Pure: the same input
   * always yields the same output, which is what makes replay idempotent.
   */
  ingest(agentSeq: number): number {
    const stored = this.base + (agentSeq + 1) * SEQ_STRIDE;
    this.#cursor = Math.max(this.#cursor, stored);
    this.#hostSinceAgent = 0;
    this.#lastAgentSeq = agentSeq;
    return stored;
  }

  /**
   * The next address for an event the host itself emits. Before the first agent
   * event these fill the gap between the base and the agent's first slot; after
   * one, they fill the gap that follows it.
   */
  host(): number {
    this.#hostSinceAgent += 1;
    if (this.#hostSinceAgent >= SEQ_STRIDE) {
      throw new SeqOverflowError(this.base, this.#lastAgentSeq, this.#hostSinceAgent);
    }
    return this.#cursor + this.#hostSinceAgent;
  }
}

/**
 * Rounds a task's existing high-water mark up to the next stride boundary, so
 * a new run's first agent event cannot collide with the previous run's tail.
 */
export function runBase(highestSeqInTask: number): number {
  if (highestSeqInTask <= 0) return 0;
  return Math.ceil((highestSeqInTask + 1) / SEQ_STRIDE) * SEQ_STRIDE;
}
