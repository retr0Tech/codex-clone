import { cn } from "../ui/cn";
import { NEAR_BUDGET, percent, type BudgetGauge } from "../../lib/usage";

/**
 * One budget bound, as a bar.
 *
 * Colour carries the same information as the text, never instead of it: the
 * numbers and the percentage are always present, so a bar that is red is
 * emphasis rather than the only way to find out what happened.
 */
export function BudgetMeter({ gauge }: { gauge: BudgetGauge }) {
  const tone = gauge.hit ? "danger" : gauge.ratio >= NEAR_BUDGET ? "warn" : "accent";
  const fill = { danger: "bg-danger", warn: "bg-warn", accent: "bg-accent" }[tone];
  const text = { danger: "text-danger", warn: "text-warn", accent: "text-fg-muted" }[tone];

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] text-fg-muted">
          {gauge.label}
          {gauge.hit ? <span className="ml-1.5 text-[11px] font-medium text-danger">stopped here</span> : null}
        </span>
        <span className="font-mono text-[11.5px] tabular-nums text-fg-faint">
          <span className={text}>{gauge.used}</span>
          <span className="text-fg-faint"> / {gauge.limit}</span>
        </span>
      </div>
      <div
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3"
        role="meter"
        aria-label={`${gauge.label}: ${gauge.used} of ${gauge.limit}`}
        aria-valuenow={Math.round(gauge.ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn("h-full rounded-full transition-[width]", fill)}
          // A bound at 0% still gets a hairline, so an empty bar reads as
          // "measured and nothing used" rather than as "not rendered".
          style={{ width: `${Math.max(gauge.ratio * 100, gauge.ratio > 0 ? 2 : 0)}%` }}
        />
      </div>
      <p className="mt-1 font-mono text-[10.5px] text-fg-faint">{percent(gauge.ratio)}</p>
    </div>
  );
}

/**
 * The cached-input split, as one bar.
 *
 * Cached tokens are reported by the provider as a SUBSET of input tokens and
 * bill at roughly a tenth of the rate, so this bar is the largest saving the
 * app has to show — and until now it was recorded on every run and displayed
 * nowhere.
 */
export function CacheMeter({ inputTokens, cachedInputTokens }: { inputTokens: number; cachedInputTokens: number }) {
  const share = inputTokens > 0 ? Math.min(1, cachedInputTokens / inputTokens) : 0;
  return (
    <div
      className="h-1.5 overflow-hidden rounded-full bg-surface-3"
      role="meter"
      aria-label={`${cachedInputTokens} of ${inputTokens} input tokens served from cache`}
      aria-valuenow={Math.round(share * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="h-full rounded-full bg-ok" style={{ width: `${share * 100}%` }} />
    </div>
  );
}
