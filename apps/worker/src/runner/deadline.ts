/**
 * The run's hard wall-clock deadline.
 *
 * The gateway meter already checks `wallClockMs` -- but it only checks it when
 * a model call arrives, so it can only stop a run the agent is still driving.
 * An agent stuck inside `shell` on a `pytest` that never returns makes no
 * further calls at all, and the meter therefore never fires. Nothing else in
 * the system was watching, so that run held one of three concurrency slots
 * until somebody noticed:
 *
 *   meter wallClockMs  →  checked on admit()  →  needs a model call to fire
 *   THIS               →  checked on a timer  →  fires regardless
 *
 * The two are the same bound seen from either side, so they take the same value
 * and the meter usually wins: it can wind the agent down politely, this one
 * cannot. This exists for the case where the polite path is unreachable.
 *
 * Timers are injected so the behaviour is unit-testable without waiting twenty
 * minutes, and the real handle is `unref()`d: a run that is winding down must
 * not be the reason the worker refuses to exit.
 */

export interface DeadlineTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const nodeTimers: DeadlineTimers = {
  set(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export class RunDeadline {
  #handle: unknown = null;
  #fired = false;

  private constructor(
    readonly wallClockMs: number,
    private readonly timers: DeadlineTimers,
  ) {}

  /**
   * Arms a deadline. `onExpire` runs at most once, and never after `cancel()`.
   *
   * A non-finite or non-positive budget disarms rather than firing immediately:
   * a misconfigured ceiling should not kill every run the moment it starts.
   */
  static arm(
    wallClockMs: number,
    onExpire: () => void,
    timers: DeadlineTimers = nodeTimers,
  ): RunDeadline {
    const deadline = new RunDeadline(wallClockMs, timers);
    if (!Number.isFinite(wallClockMs) || wallClockMs <= 0) return deadline;

    deadline.#handle = timers.set(() => {
      deadline.#handle = null;
      deadline.#fired = true;
      onExpire();
    }, wallClockMs);
    return deadline;
  }

  get fired(): boolean {
    return this.#fired;
  }

  get armed(): boolean {
    return this.#handle !== null;
  }

  /** Idempotent: every exit path from a run calls this, including the throws. */
  cancel(): void {
    if (this.#handle === null) return;
    this.timers.clear(this.#handle);
    this.#handle = null;
  }
}

/**
 * The stop reason a timed-out run carries, in one place so the transcript, the
 * `runs` row and the UI all say the same thing.
 */
export function wallClockReason(wallClockMs: number): string {
  const minutes = wallClockMs / 60_000;
  const rendered = Number.isInteger(minutes) ? `${minutes}m` : `${Math.round(wallClockMs / 1000)}s`;
  return `the wall-clock limit of ${rendered} was reached; the sandbox was stopped`;
}
