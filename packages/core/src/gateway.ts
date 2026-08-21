/**
 * Host-side model gateway protocol.
 *
 *   container: POST unix:/run/gateway.sock /v1/responses   <- holds NO key
 *        v
 *   host gateway: attach OpenAI key -> api.openai.com
 *                 stream back, meter tokens + cost, enforce budgets
 *
 * Three things fall out of moving the call to the host:
 *   1. the sandbox holds zero credentials, so prompt injection has nothing
 *      to exfiltrate;
 *   2. there is exactly one place that knows per-run cost;
 *   3. tests swap in a fake gateway and run with no network at all.
 *
 * In production this becomes a metering broker in front of the model provider.
 */

export interface GatewayRequest {
  /** Correlates the call with a run for metering and budget enforcement. */
  runId: string;
  model: string;
  /** Passthrough of OpenAI Responses API input. Auth is added by the host. */
  input: unknown;
  tools?: unknown;
  stream: boolean;
}

export type GatewayChunk =
  | { type: "delta"; messageId: string; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; callId: string; name: string; args: string }
  | { type: "done"; usage: TokenUsage }
  /** Budget breach, cancellation or upstream failure. The agent must not hang on this. */
  | { type: "refused"; reason: RefusalReason; message: string };

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type BudgetBreach = "max_turns" | "max_cost" | "wall_clock";

/**
 * Why the gateway declined a call.
 *
 * `cancelled` is NOT a budget breach and must never be rendered as one. A
 * previous milestone shipped a bug where stopping a run from the UI closed the
 * meter with a `wall_clock` breach, and the transcript then told the user their
 * budget was exhausted -- which was simply untrue. Carrying the distinction in
 * the type rather than only in the prose message is what keeps that fixed: an
 * exhaustive switch on this union cannot quietly lump the two together again.
 */
export type RefusalReason = BudgetBreach | "upstream_error" | "cancelled";

/** One wording per bound, so the worker and the UI cannot describe it differently. */
export const BREACH_LABEL: Record<BudgetBreach, string> = {
  max_turns: "the turn ceiling",
  max_cost: "the cost ceiling",
  wall_clock: "the wall-clock limit",
};

export interface RunBudget {
  maxTurns: number;
  maxCostUsd: number;
  wallClockMs: number;
}

/**
 * A typical successful run costs a fraction of a cent, so the cost ceiling
 * exists to bound a RUNAWAY run, not a normal one. It is set well below the
 * kind of prepaid quota this app is developed against, so that a single
 * pathological run -- an agent looping on a failing test -- cannot consume a
 * meaningful share of the budget before the wind-down fires.
 */
export const DEFAULT_BUDGET: RunBudget = {
  maxTurns: 40,
  maxCostUsd: 1,
  wallClockMs: 20 * 60 * 1000,
};

export interface BudgetUsage {
  turns: number;
  costUsd: number;
  elapsedMs: number;
}

/**
 * On breach the gateway does NOT hard-kill. It injects a wind-down
 * instruction so the agent gets one final turn to commit and explain itself,
 * then the worker SIGTERMs. Partial work survives regardless -- the hot volume
 * is the live state.
 */
export const WIND_DOWN_INSTRUCTION =
  "Your budget for this run is exhausted. Do not start new work. " +
  "Commit anything already in progress, then summarise what you completed " +
  "and what remains. This is your final turn.";

export function checkBudget(budget: RunBudget, usage: BudgetUsage): BudgetBreach | null {
  if (usage.turns >= budget.maxTurns) return "max_turns";
  if (usage.costUsd >= budget.maxCostUsd) return "max_cost";
  if (usage.elapsedMs >= budget.wallClockMs) return "wall_clock";
  return null;
}

/**
 * The accepted range for each bound, in one place.
 *
 * A budget is user-editable (Settings), so it arrives from an HTTP body and has
 * to be validated somewhere. Putting the ranges here rather than in the route
 * means the worker enforces exactly what the form offered, and a budget stored
 * before a range changed is still checkable.
 *
 * The upper bounds are deliberately conservative: this app is developed against
 * a small prepaid quota, and a text field that accepts `100000` for maxCostUsd
 * is a footgun with no upside.
 */
export const BUDGET_FIELDS = [
  { key: "maxTurns", label: "Max turns", min: 1, max: 200, integer: true },
  { key: "maxCostUsd", label: "Max cost (USD)", min: 0.01, max: 50, integer: false },
  { key: "wallClockMs", label: "Wall clock (ms)", min: 30_000, max: 4 * 60 * 60 * 1000, integer: true },
] as const satisfies ReadonlyArray<{
  key: keyof RunBudget;
  label: string;
  min: number;
  max: number;
  integer: boolean;
}>;

/** Null when the budget is usable; otherwise the first problem, phrased for a human. */
export function budgetProblem(budget: RunBudget): string | null {
  for (const field of BUDGET_FIELDS) {
    const value = budget[field.key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `${field.label} must be a number.`;
    }
    if (field.integer && !Number.isInteger(value)) {
      return `${field.label} must be a whole number.`;
    }
    if (value < field.min || value > field.max) {
      return `${field.label} must be between ${field.min} and ${field.max}.`;
    }
  }
  return null;
}
