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
  /** Budget breach or upstream failure. The agent must not hang on this. */
  | { type: "refused"; reason: BudgetBreach | "upstream_error"; message: string };

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type BudgetBreach = "max_turns" | "max_cost" | "wall_clock";

export interface RunBudget {
  maxTurns: number;
  maxCostUsd: number;
  wallClockMs: number;
}

export const DEFAULT_BUDGET: RunBudget = {
  maxTurns: 40,
  maxCostUsd: 5,
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
