"use client";

import type { RunBudget } from "@codex-clone/core";
import type { RunView } from "../../lib/types";
import { formatDuration } from "../../lib/format";
import { STATUS_META } from "../../lib/status";
import {
  budgetGauges,
  budgetVerdict,
  cachedShare,
  formatTokens,
  formatUsd,
  percent,
  runElapsedMs,
  sumUsage,
  totalTokens,
  uncachedInputTokens,
  type UsageTotals,
  type VerdictKind,
} from "../../lib/usage";
import { Badge } from "../ui/Badge";
import { cn } from "../ui/cn";
import { EmptyState, SectionHeading } from "../ui/misc";
import { BudgetMeter, CacheMeter } from "./Meter";

/**
 * What this task cost, and how close each run came to its bounds.
 *
 * Every figure here was measured at the gateway and written to the `runs` row
 * as the run went (PLAN.md §3.3). Nothing is recomputed from the transcript,
 * and nothing is estimated — which is why a run whose container died still
 * shows the tokens it had already spent.
 */
export function UsagePanel({ runs, budget }: { runs: readonly RunView[]; budget: RunBudget }) {
  if (runs.length === 0) {
    return (
      <EmptyState
        title="Nothing metered yet"
        body="Tokens and cost are recorded at the host gateway, per model call. This task has not made one."
      />
    );
  }

  const totals = sumUsage(runs);
  const wallClock = runs.reduce((total, run) => total + runElapsedMs(run), 0);

  return (
    <div className="space-y-8">
      <section>
        <SectionHeading
          aside={
            <span className="text-[11.5px] text-fg-faint">
              {runs.length} run{runs.length === 1 ? "" : "s"} · {formatDuration(wallClock)} of sandbox time
            </span>
          }
        >
          This task
        </SectionHeading>
        <TotalsCard totals={totals} />
      </section>

      <section>
        <SectionHeading aside={<span className="text-[11.5px] text-fg-faint">newest last</span>}>
          Per run
        </SectionHeading>
        <ul className="space-y-3">
          {runs.map((run, index) => (
            <li key={run.id}>
              <RunCard run={run} index={index + 1} budget={budget} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function TotalsCard({ totals }: { totals: UsageTotals }) {
  const share = cachedShare(totals);
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
        <Figure label="Spent" value={formatUsd(totals.costUsd)} big />
        <Figure label="Turns" value={String(totals.turns)} />
        <Figure label="Tokens" value={formatTokens(totalTokens(totals))} />
      </div>

      <div className="mt-4 border-t border-border pt-3.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[12px] text-fg-muted">Input, cached vs billed in full</span>
          <span className="font-mono text-[11.5px] tabular-nums text-fg-faint">
            {formatTokens(totals.cachedInputTokens)} cached / {formatTokens(totals.inputTokens)}
          </span>
        </div>
        <div className="mt-1.5">
          <CacheMeter inputTokens={totals.inputTokens} cachedInputTokens={totals.cachedInputTokens} />
        </div>
        <p className="mt-1.5 text-[11.5px] leading-4 text-fg-faint">
          {totals.cachedInputTokens > 0 ? (
            <>
              <span className="text-ok">{percent(share)}</span> of this task&rsquo;s input came from the prompt
              cache, at roughly a tenth of the input rate. The other {formatTokens(uncachedInputTokens(totals))} were
              billed in full.
            </>
          ) : (
            <>
              No prompt cache hits yet. Cached input bills at roughly a tenth of the input rate, so a follow-up turn
              against the same warm workspace is normally where this starts paying.
            </>
          )}
        </p>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] tabular-nums text-fg-faint">
        <span>input {formatTokens(totals.inputTokens)}</span>
        <span>output {formatTokens(totals.outputTokens)}</span>
      </div>
    </div>
  );
}

function Figure({ label, value, big = false }: { label: string; value: string; big?: boolean }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-[0.08em] text-fg-faint">{label}</p>
      <p className={big ? "mt-0.5 font-mono text-[22px] tabular-nums" : "mt-0.5 font-mono text-[15px] tabular-nums"}>
        {value}
      </p>
    </div>
  );
}

/**
 * Written out rather than interpolated: Tailwind scans source text for class
 * names, so `text-${tone}` produces a class it never generates and a verdict
 * that renders in the body colour.
 */
const VERDICT_CLASS: Record<VerdictKind, string> = {
  cancelled: "text-warn",
  stopped: "text-danger",
  near: "text-warn",
  clear: "text-ok",
  pending: "text-info",
};

function RunCard({ run, index, budget }: { run: RunView; index: number; budget: RunBudget }) {
  const usage = sumUsage([run]);
  const elapsed = runElapsedMs(run);
  const gauges = budgetGauges(budget, usage, elapsed, run.budgetBreach);
  const verdict = budgetVerdict(run, gauges);
  const status = STATUS_META[run.status];

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[12.5px]">
            <span className="font-mono text-fg-faint">#{index}</span>
            <span className="truncate text-fg-muted">{run.prompt}</span>
          </p>
          <p className="mt-1 font-mono text-[11px] tabular-nums text-fg-faint">
            {run.turns} turn{run.turns === 1 ? "" : "s"} · {formatUsd(run.costUsd)} ·{" "}
            {formatTokens(totalTokens(usage))} tokens
            {run.cachedInputTokens > 0 ? ` · ${formatTokens(run.cachedInputTokens)} cached` : ""}
            {elapsed > 0 ? ` · ${formatDuration(elapsed)}` : ""}
          </p>
        </div>
        <Badge tone={status.tone} dot={run.status === "running"}>
          {status.label}
        </Badge>
      </div>

      <p className={cn("mt-2.5 text-[12px]", VERDICT_CLASS[verdict.kind])}>{verdict.text}</p>

      <div className="mt-3.5 grid gap-4 sm:grid-cols-3">
        {gauges.map((gauge) => (
          <BudgetMeter key={gauge.key} gauge={gauge} />
        ))}
      </div>

      {run.stopReason ? (
        <p className="mt-3 border-t border-border pt-2.5 text-[11.5px] leading-4 text-fg-faint">{run.stopReason}</p>
      ) : null}
    </div>
  );
}
