import Link from "next/link";
import { DEFAULT_BUDGET, type RunBudget } from "@codex-clone/core";
import { Badge } from "../../components/ui/Badge";
import { EmptyState, SectionHeading } from "../../components/ui/misc";
import { CacheMeter } from "../../components/usage/Meter";
import { STATUS_META } from "../../lib/status";
import {
  cachedShare,
  formatDurationShort,
  formatTokens,
  formatUsd,
  percent,
  runElapsedMs,
  totalTokens,
  uncachedInputTokens,
} from "../../lib/usage";
import { readRunBudget } from "../api/_lib/budget";
import { db } from "../api/_lib/settings-store";
import { listTaskSpend, type TaskSpend } from "./data";
import { summarise } from "./summary";

/**
 * Where the money went.
 *
 * Deliberately not an analytics product: no charts, no date ranges, no
 * retention policy. Every figure is read straight from the `runs` rows the
 * gateway wrote as each run went, so this page cannot disagree with the Usage
 * tab on a task -- they are the same numbers, grouped differently.
 */

export const metadata = { title: "Usage · codex-clone" };
export const dynamic = "force-dynamic";

export default async function UsagePage() {
  let tasks: TaskSpend[] = [];
  let budget: RunBudget = DEFAULT_BUDGET;
  let problem: string | null = null;
  try {
    const database = db();
    [tasks, budget] = await Promise.all([listTaskSpend(database), readRunBudget(database)]);
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }

  const summary = summarise(tasks);
  const share = cachedShare(summary.totals);

  return (
    <div className="px-5 py-8 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-8">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Usage</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-fg-muted">
            Tokens and cost are metered at the host model gateway — the one component every model call passes through,
            and therefore the only place that can honestly count them. These are the figures written to each run as it
            ran, not an estimate reconstructed from the transcript.
          </p>
        </div>

        {problem ? (
          <p className="rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-[13px] text-danger">
            {problem}
          </p>
        ) : null}

        <section className="rounded-xl border border-border bg-surface p-5">
          <div className="flex flex-wrap items-baseline gap-x-10 gap-y-4">
            <Figure label="Total spend" value={formatUsd(summary.totals.costUsd)} big />
            <Figure label="Runs" value={String(summary.runCount)} />
            <Figure label="Turns" value={String(summary.totals.turns)} />
            <Figure label="Tokens" value={formatTokens(totalTokens(summary.totals))} />
          </div>

          <div className="mt-5 border-t border-border pt-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12px] text-fg-muted">Input served from the prompt cache</span>
              <span className="font-mono text-[11.5px] tabular-nums text-fg-faint">
                {formatTokens(summary.totals.cachedInputTokens)} / {formatTokens(summary.totals.inputTokens)}
              </span>
            </div>
            <div className="mt-1.5">
              <CacheMeter
                inputTokens={summary.totals.inputTokens}
                cachedInputTokens={summary.totals.cachedInputTokens}
              />
            </div>
            <p className="mt-2 text-[11.5px] leading-4 text-fg-faint">
              Cached input bills at roughly a tenth of the input rate, so this bar is the largest single saving on the
              page.{" "}
              {summary.totals.cachedInputTokens > 0 ? (
                <>
                  <span className="text-ok">{percent(share)}</span> of all input has been cached;{" "}
                  {formatTokens(uncachedInputTokens(summary.totals))} tokens were billed in full.
                </>
              ) : (
                <>Nothing has hit the cache yet.</>
              )}
            </p>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3.5">
            <Badge tone={summary.stoppedByBudget > 0 ? "warn" : "neutral"}>
              {summary.stoppedByBudget} stopped by a bound
            </Badge>
            <Badge tone="neutral">{summary.cancelled} cancelled</Badge>
            <span className="text-[11.5px] text-fg-faint">
              Cancelling is never counted as a budget breach — the run loop records which bound stopped a run, and a
              cancelled one has none.
            </span>
          </div>
        </section>

        <section>
          <SectionHeading
            aside={
              <Link href="/settings" className="text-[12px] text-fg-muted hover:text-fg">
                Change the budget →
              </Link>
            }
          >
            Current run bounds
          </SectionHeading>
          <div className="grid gap-3 sm:grid-cols-3">
            <Bound label="Max turns" value={String(budget.maxTurns)} />
            <Bound label="Max cost" value={formatUsd(budget.maxCostUsd)} />
            <Bound label="Wall clock" value={formatDurationShort(budget.wallClockMs)} />
          </div>
          <p className="mt-2 text-[11.5px] leading-4 text-fg-faint">
            Applied to every new run. Reaching a bound injects a wind-down instruction and grants exactly one more turn
            so the agent can commit what it has, and only then is the container stopped.
          </p>
        </section>

        <section>
          <SectionHeading aside={<span className="text-[11.5px] text-fg-faint">most expensive first</span>}>
            By task
          </SectionHeading>
          {summary.topTasks.length === 0 ? (
            <EmptyState
              title="Nothing metered yet"
              body="Create a task and run it; the gateway records tokens and cost per model call as it goes."
            />
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {summary.topTasks.map(({ task, totals }) => {
                const elapsed = task.runs.reduce((sum, run) => sum + runElapsedMs(run), 0);
                const latest = task.runs[task.runs.length - 1];
                const status = latest ? STATUS_META[latest.status] : null;
                return (
                  <li key={task.taskId}>
                    <Link href={`/tasks/${task.taskId}`} className="block px-4 py-3 hover:bg-surface-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <span className="min-w-0 truncate text-[13px] font-medium">{task.title}</span>
                        <span className="font-mono text-[13px] tabular-nums">{formatUsd(totals.costUsd)}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px] tabular-nums text-fg-faint">
                        <span className="text-fg-muted">{task.repoFullName}</span>
                        <span aria-hidden>·</span>
                        <span>
                          {task.runs.length} run{task.runs.length === 1 ? "" : "s"}
                        </span>
                        <span aria-hidden>·</span>
                        <span>{totals.turns} turns</span>
                        <span aria-hidden>·</span>
                        <span>{formatTokens(totalTokens(totals))} tok</span>
                        {totals.cachedInputTokens > 0 ? (
                          <>
                            <span aria-hidden>·</span>
                            <span className="text-ok">{formatTokens(totals.cachedInputTokens)} cached</span>
                          </>
                        ) : null}
                        {elapsed > 0 ? (
                          <>
                            <span aria-hidden>·</span>
                            <span>{formatDurationShort(elapsed)}</span>
                          </>
                        ) : null}
                        {task.archived ? <Badge tone="neutral">Archived</Badge> : null}
                        {status ? <Badge tone={status.tone}>{status.label}</Badge> : null}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Figure({ label, value, big = false }: { label: string; value: string; big?: boolean }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-[0.08em] text-fg-faint">{label}</p>
      <p className={big ? "mt-0.5 font-mono text-[26px] tabular-nums" : "mt-0.5 font-mono text-[16px] tabular-nums"}>
        {value}
      </p>
    </div>
  );
}

function Bound({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3.5 py-2.5">
      <p className="text-[11px] uppercase tracking-[0.08em] text-fg-faint">{label}</p>
      <p className="mt-0.5 font-mono text-[15px] tabular-nums">{value}</p>
    </div>
  );
}
