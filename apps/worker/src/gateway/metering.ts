import type { BudgetBreach, BudgetUsage, RunBudget, TokenUsage } from "@codex-clone/core";
import { checkBudget, DEFAULT_BUDGET } from "@codex-clone/core";

/**
 * Per-run token, cost and budget state.
 *
 * Budgets are enforced HERE and nowhere else (PLAN.md section 3.4). The
 * container cannot be trusted to stop itself, and the worker only sees events,
 * so the gateway -- the one component every model call passes through -- is the
 * only place that can both count and refuse.
 *
 * The refusal is deliberately soft. On breach we inject a wind-down
 * instruction and grant exactly one more turn, so the agent can commit what it
 * has and explain itself; only after that does it get `refused`. A hard kill
 * at the moment of breach throws away the most valuable turn of the run.
 */

export type MeterState = "open" | "winding_down" | "closed";

export interface RunMeterSnapshot {
  runId: string;
  turns: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  elapsedMs: number;
  state: MeterState;
  /**
   * The bound that was actually hit, or null. Null for a meter that was closed
   * deliberately (cancel, host wind-down) rather than by a budget -- see
   * `cancel()` below. Everything downstream that renders a breach reads this,
   * so "cancelled" and "budget exhausted" cannot be conflated by accident.
   */
  breach: BudgetBreach | null;
  /** True when a human stopped this run. Mutually exclusive with a breach. */
  cancelled: boolean;
  /** Why the meter was closed, in the words of whoever closed it. */
  closedReason: string | null;
  /** The budget this run was measured against, for honest headroom reporting. */
  budget: RunBudget;
}

export class RunMeter {
  #turns = 0;
  #inputTokens = 0;
  #cachedInputTokens = 0;
  #outputTokens = 0;
  #costUsd = 0;
  #state: MeterState = "open";
  #breach: BudgetBreach | null = null;
  #cancelled = false;
  readonly startedAt: number;

  constructor(
    readonly runId: string,
    readonly budget: RunBudget = DEFAULT_BUDGET,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  get state(): MeterState {
    return this.#state;
  }

  usage(): BudgetUsage {
    return { turns: this.#turns, costUsd: this.#costUsd, elapsedMs: this.now() - this.startedAt };
  }

  snapshot(): RunMeterSnapshot {
    return {
      runId: this.runId,
      turns: this.#turns,
      inputTokens: this.#inputTokens,
      cachedInputTokens: this.#cachedInputTokens,
      outputTokens: this.#outputTokens,
      costUsd: this.#costUsd,
      elapsedMs: this.now() - this.startedAt,
      state: this.#state,
      breach: this.#breach,
      cancelled: this.#cancelled,
      closedReason: this.#closedReason,
      budget: this.budget,
    };
  }

  record(usage: TokenUsage): void {
    this.#inputTokens += usage.inputTokens;
    this.#cachedInputTokens += usage.cachedInputTokens;
    this.#outputTokens += usage.outputTokens;
    this.#costUsd += usage.costUsd;
  }

  /**
   * Called once per inbound request. Returns what the gateway should do:
   *
   *   forward   - under budget, proceed normally
   *   wind_down - over budget, first time: inject WIND_DOWN_INSTRUCTION and
   *               forward this ONE final turn
   *   refuse    - the wind-down turn is spent; emit `refused` and call nothing
   *
   * Note the turn is counted before the check, so `maxTurns: 40` means forty
   * model calls, not forty-one.
   */
  admit():
    | { action: "forward" }
    | { action: "wind_down"; breach: BudgetBreach }
    | { action: "refuse"; reason: BudgetBreach | "cancelled" } {
    if (this.#state === "closed") {
      return { action: "refuse", reason: this.#refusalReason() };
    }
    if (this.#state === "winding_down") {
      // The wind-down turn was already granted and is now being asked for a
      // second time. This is the hard stop.
      this.#state = "closed";
      return { action: "refuse", reason: this.#refusalReason() };
    }

    const breach = checkBudget(this.budget, this.usage());
    if (breach) {
      this.#state = "winding_down";
      this.#breach = breach;
      this.#turns++;
      return { action: "wind_down", breach };
    }

    this.#turns++;
    return { action: "forward" };
  }

  /**
   * Why this meter was closed, in the words of whoever closed it. Surfaced to
   * the agent as the refusal message, so it ends up in the transcript verbatim.
   */
  #closedReason: string | null = null;

  get closedReason(): string | null {
    return this.#closedReason;
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  #refusalReason(): BudgetBreach | "cancelled" {
    if (this.#cancelled) return "cancelled";
    // A meter can only be closed by a breach or by `cancel()`, so this fallback
    // is unreachable; `max_turns` is the least alarming thing to say if it ever
    // is reached.
    return this.#breach ?? "max_turns";
  }

  /**
   * A human stopped this run. NOT a budget breach.
   *
   * A cancel and a wall-clock breach take the same path -- no more model calls,
   * immediately -- but they are not the same event, and the refusal the agent
   * receives ends up in the transcript. Before this existed, cancelling from
   * the UI closed the meter with a `wall_clock` breach and the user was told
   * their budget was exhausted, which was simply untrue. `breach` stays null
   * here so that nothing downstream can render this run as a budget breach.
   */
  cancel(reason: string): void {
    this.#state = "closed";
    this.#cancelled = true;
    this.#closedReason ??= reason;
  }

  /** A bound was hit: no further model call is admitted for this run. */
  close(breach: BudgetBreach, reason?: string): void {
    this.#state = "closed";
    this.#breach ??= breach;
    this.#closedReason ??= reason ?? null;
  }
}

/**
 * Meters keyed by runId, created on first sight.
 *
 * Runs are finite and the worker caps concurrency at three, but a long-lived
 * process still needs a way to forget: `release` is called when the worker
 * finalises a run.
 */
export class MeterRegistry {
  readonly #meters = new Map<string, RunMeter>();

  constructor(
    private readonly budget: RunBudget = DEFAULT_BUDGET,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The meter for a run, created on first sight.
   *
   * `budget` overrides the registry default for a run that has not been seen
   * yet, which is how a budget edited in Settings takes effect on the next run
   * rather than on the next worker restart. It is deliberately ignored for a
   * run already in flight: a budget must not move under a run that is being
   * measured against it.
   */
  for(runId: string, budget?: RunBudget): RunMeter {
    let meter = this.#meters.get(runId);
    if (!meter) {
      meter = new RunMeter(runId, budget ?? this.budget, this.now);
      this.#meters.set(runId, meter);
    }
    return meter;
  }

  peek(runId: string): RunMeter | undefined {
    return this.#meters.get(runId);
  }

  release(runId: string): RunMeterSnapshot | null {
    const meter = this.#meters.get(runId);
    if (!meter) return null;
    this.#meters.delete(runId);
    return meter.snapshot();
  }

  get size(): number {
    return this.#meters.size;
  }
}
