import type { TokenUsage } from "@codex-clone/core";

/**
 * Cost accounting lives here because the gateway is the only place that sees
 * every model call for a run (PLAN.md section 3.3). One home for cost means
 * the number shown in the UI, the number the budget is enforced against, and
 * the number written to `runs.cost_usd` cannot disagree.
 */

export interface ModelPricing {
  /** USD per 1M tokens. */
  inputPerMTok: number;
  cachedInputPerMTok: number;
  outputPerMTok: number;
}

/**
 * Prices are configuration, not truth: they change, and a stale table
 * silently under-reports spend. Keep this in one place so it is one edit, and
 * treat an unknown model as expensive rather than free (see below).
 */
export const PRICING: Record<string, ModelPricing> = {
  "gpt-5": { inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 },
  "gpt-5-mini": { inputPerMTok: 0.25, cachedInputPerMTok: 0.025, outputPerMTok: 2 },
  "gpt-5-nano": { inputPerMTok: 0.05, cachedInputPerMTok: 0.005, outputPerMTok: 0.4 },
  "gpt-4.1": { inputPerMTok: 2, cachedInputPerMTok: 0.5, outputPerMTok: 8 },
  "gpt-4.1-mini": { inputPerMTok: 0.4, cachedInputPerMTok: 0.1, outputPerMTok: 1.6 },
  "gpt-4o": { inputPerMTok: 2.5, cachedInputPerMTok: 1.25, outputPerMTok: 10 },
};

/**
 * An unknown model bills at the most expensive rate we know about.
 *
 * The alternative -- billing an unrecognised model at zero -- means a typo in
 * the model name silently disables the cost budget for the whole run. Erring
 * expensive makes a missing price entry show up as a run that winds down early,
 * which someone will notice and fix.
 */
export const UNKNOWN_MODEL_PRICING: ModelPricing = Object.values(PRICING).reduce((worst, p) =>
  p.outputPerMTok > worst.outputPerMTok ? p : worst,
);

export function pricingFor(model: string): ModelPricing {
  // Deployment ids often carry a suffix ("gpt-5-2025-08-07"); match the
  // longest configured prefix rather than failing to the fallback.
  const exact = PRICING[model];
  if (exact) return exact;

  let best: { name: string; pricing: ModelPricing } | null = null;
  for (const [name, pricing] of Object.entries(PRICING)) {
    if (model.startsWith(name) && (best === null || name.length > best.name.length)) {
      best = { name, pricing };
    }
  }
  return best?.pricing ?? UNKNOWN_MODEL_PRICING;
}

export interface RawUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export function computeCost(model: string, usage: RawUsage): TokenUsage {
  const p = pricingFor(model);
  // Cached input tokens are reported by OpenAI as a subset of input tokens, so
  // the uncached portion is the difference. Billing both in full would
  // double-count exactly the tokens caching is supposed to make cheap.
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const costUsd =
    (uncachedInput * p.inputPerMTok) / 1_000_000 +
    (usage.cachedInputTokens * p.cachedInputPerMTok) / 1_000_000 +
    (usage.outputTokens * p.outputPerMTok) / 1_000_000;

  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    costUsd,
  };
}
