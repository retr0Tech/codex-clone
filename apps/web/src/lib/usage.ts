import type { BudgetBreach, RunBudget } from "@codex-clone/core";
import { BREACH_LABEL } from "@codex-clone/core";
import type { RunView } from "./types";

/**
 * Cost, tokens and budget headroom, derived from what the gateway already
 * measured.
 *
 * Nothing here counts anything. The gateway is the only component that sees
 * every model call, so it is the only honest source for these numbers
 * (PLAN.md §3.3); this file turns the columns it wrote onto the `runs` row into
 * the shapes a screen needs. Keeping that arithmetic out of the components is
 * what makes it testable -- the interesting rules below are rules about
 * *honesty*, and an untested rule about honesty is a rule that stops holding.
 *
 * The two that matter most:
 *
 *  1. A CANCELLED run is never a budget breach. `runs.budget_breach` is null
 *     for one, and `budgetVerdict` refuses to invent a breach from the numbers.
 *  2. Cached input tokens are a SUBSET of input tokens, never an addition. They
 *     bill at roughly a tenth of the rate, which is the single largest saving
 *     available here, and totalling them alongside input would both double-count
 *     the run and hide the saving.
 */

export interface UsageTotals {
  turns: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export const EMPTY_USAGE: UsageTotals = {
  turns: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
};

export function sumUsage(runs: readonly RunView[]): UsageTotals {
  return runs.reduce<UsageTotals>(
    (total, run) => ({
      turns: total.turns + run.turns,
      inputTokens: total.inputTokens + run.inputTokens,
      cachedInputTokens: total.cachedInputTokens + run.cachedInputTokens,
      outputTokens: total.outputTokens + run.outputTokens,
      costUsd: total.costUsd + run.costUsd,
    }),
    EMPTY_USAGE,
  );
}

/** Input tokens that were NOT served from the prompt cache, and so billed in full. */
export function uncachedInputTokens(usage: UsageTotals): number {
  return Math.max(0, usage.inputTokens - usage.cachedInputTokens);
}

/** The fraction of input tokens the cache covered, 0..1. Zero input reads as 0. */
export function cachedShare(usage: UsageTotals): number {
  if (usage.inputTokens <= 0) return 0;
  return Math.min(1, usage.cachedInputTokens / usage.inputTokens);
}

export function totalTokens(usage: UsageTotals): number {
  // Cached is a subset of input, so it is deliberately absent from this sum.
  return usage.inputTokens + usage.outputTokens;
}

/**
 * How long a run occupied a sandbox slot.
 *
 * Falls back to `createdAt` when the worker never got as far as recording
 * `startedAt`, and returns 0 rather than a negative number if the clocks
 * disagree -- a duration of "-3s" in a table is worse than no duration.
 */
export function runElapsedMs(run: RunView, now = Date.now()): number {
  const started = Date.parse(run.startedAt ?? run.createdAt);
  if (Number.isNaN(started)) return 0;
  const ended = run.endedAt === null ? now : Date.parse(run.endedAt);
  if (Number.isNaN(ended)) return 0;
  return Math.max(0, ended - started);
}

/* -------------------------------------------------------------------------- */
/* Budget headroom                                                             */
/* -------------------------------------------------------------------------- */

export interface BudgetGauge {
  key: keyof RunBudget;
  breach: BudgetBreach;
  label: string;
  /** Rendered "used of limit", already formatted for display. */
  used: string;
  limit: string;
  /** 0..1, clamped. What a progress bar should show. */
  ratio: number;
  /** True when this specific bound is the one that stopped the run. */
  hit: boolean;
}

/**
 * The three bounds of a run, each as "how close did this get".
 *
 * Measured against the budget as it is configured NOW, which is the only
 * budget we store -- so a bound raised after a run finished will make that run
 * look roomier than it felt. The panel says as much rather than pretending
 * otherwise; recording three more columns per run to avoid it is not worth the
 * schema.
 */
export function budgetGauges(budget: RunBudget, usage: UsageTotals, elapsedMs: number, breach: BudgetBreach | null): BudgetGauge[] {
  return [
    {
      key: "maxTurns",
      breach: "max_turns",
      label: "Turns",
      used: String(usage.turns),
      limit: String(budget.maxTurns),
      ratio: ratio(usage.turns, budget.maxTurns),
      hit: breach === "max_turns",
    },
    {
      key: "maxCostUsd",
      breach: "max_cost",
      label: "Cost",
      used: formatUsd(usage.costUsd),
      limit: formatUsd(budget.maxCostUsd),
      ratio: ratio(usage.costUsd, budget.maxCostUsd),
      hit: breach === "max_cost",
    },
    {
      key: "wallClockMs",
      breach: "wall_clock",
      label: "Wall clock",
      used: formatDurationShort(elapsedMs),
      limit: formatDurationShort(budget.wallClockMs),
      ratio: ratio(elapsedMs, budget.wallClockMs),
      hit: breach === "wall_clock",
    },
  ];
}

function ratio(used: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.max(0, Math.min(1, used / limit));
}

/** Past this share of a bound, a run is worth flagging as close to the edge. */
export const NEAR_BUDGET = 0.8;

export type VerdictKind = "cancelled" | "stopped" | "near" | "clear" | "pending";

export interface BudgetVerdict {
  kind: VerdictKind;
  text: string;
}

/**
 * What to say about a run's relationship with its budget.
 *
 * The cancelled case is first and unconditional. A run someone stopped can
 * easily have been near a ceiling as well -- that is often *why* they stopped
 * it -- and reporting it as a breach would be a lie in the one place the user
 * is looking for the consequence of their own click.
 */
export function budgetVerdict(run: RunView, gauges: readonly BudgetGauge[]): BudgetVerdict {
  if (run.status === "cancelled") {
    return { kind: "cancelled", text: "Stopped from the UI. Not a budget breach — partial work was kept." };
  }
  if (run.status === "queued" || run.status === "running") {
    return { kind: "pending", text: "In flight. Budget is enforced at the gateway, per model call." };
  }
  if (run.budgetBreach) {
    const label = BREACH_LABEL[run.budgetBreach];
    return { kind: "stopped", text: `Stopped because ${label} was reached.` };
  }

  const closest = [...gauges].sort((a, b) => b.ratio - a.ratio)[0];
  if (closest && closest.ratio >= NEAR_BUDGET) {
    return {
      kind: "near",
      text: `Finished with little headroom: ${percent(closest.ratio)} of ${BREACH_LABEL[closest.breach]}.`,
    };
  }
  return {
    kind: "clear",
    text: closest
      ? `Finished well inside every bound — the closest was ${BREACH_LABEL[closest.breach]} at ${percent(closest.ratio)}.`
      : "Finished inside every bound.",
  };
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A normal run here costs a fraction of a cent, so two decimals would round
 * every real figure to $0.00 and make the whole panel look broken. Four
 * decimals below a cent, two above, which is where the extra digits stop
 * carrying information.
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "$0.00";
  const abs = Math.abs(usd);
  return `$${usd.toFixed(abs > 0 && abs < 0.01 ? 4 : 2)}`;
}

export function formatTokens(count: number): string {
  if (!Number.isFinite(count)) return "0";
  if (Math.abs(count) < 1_000) return String(Math.round(count));
  if (Math.abs(count) < 1_000_000) return `${trim(count / 1_000)}k`;
  return `${trim(count / 1_000_000)}M`;
}

function trim(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

export function percent(ratio01: number): string {
  if (!Number.isFinite(ratio01)) return "0%";
  const pct = ratio01 * 100;
  // Below 1% but not zero, "0%" reads as "nothing happened"; it did.
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/** Compact enough for a gauge label: 20m, 1h 30m, 45s. */
export function formatDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
