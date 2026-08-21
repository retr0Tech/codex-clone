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
  breach: BudgetBreach | null;
}

export class RunMeter {
  #turns = 0;
  #inputTokens = 0;
  #cachedInputTokens = 0;
  #outputTokens = 0;
  #costUsd = 0;
  #state: MeterState = "open";
  #breach: BudgetBreach | null = null;
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
  admit(): { action: "forward" } | { action: "wind_down"; breach: BudgetBreach } | { action: "refuse"; breach: BudgetBreach } {
    if (this.#state === "closed") {
      return { action: "refuse", breach: this.#breach ?? "max_turns" };
    }
    if (this.#state === "winding_down") {
      // The wind-down turn was already granted and is now being asked for a
      // second time. This is the hard stop.
      this.#state = "closed";
      return { action: "refuse", breach: this.#breach ?? "max_turns" };
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
   * Why this meter was closed, in the words of whoever closed it.
   *
   * A cancel and a wall-clock breach take the same path -- no more model calls,
   * immediately -- but they are not the same event, and the refusal the agent
   * receives ends up in the transcript. Without this, cancelling from the UI
   * told the user their budget was exhausted, which was simply untrue.
   * `BudgetBreach` is a frozen union in core, so the distinction is carried as
   * a message rather than as a fourth member of it.
   */
  #closedReason: string | null = null;

  get closedReason(): string | null {
    return this.#closedReason;
  }

  /** Cancel from the UI takes the same path as a breach: no more model calls. */
  close(breach: BudgetBreach = "wall_clock", reason?: string): void {
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

  for(runId: string): RunMeter {
    let meter = this.#meters.get(runId);
    if (!meter) {
      meter = new RunMeter(runId, this.budget, this.now);
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
