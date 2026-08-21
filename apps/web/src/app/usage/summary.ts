import type { RunStatus } from "@codex-clone/core";
import { sumUsage, type UsageTotals } from "../../lib/usage";
import type { TaskSpend } from "./data";

/**
 * The arithmetic behind the spend page, kept out of the page component so it
 * can be tested without a database or a renderer.
 *
 * The one rule worth pinning down: `stoppedByBudget` counts runs a *budget*
 * stopped, and a cancelled run is not one of them however close to a ceiling it
 * got. That number is the reason someone would come to this page to raise a
 * limit, and inflating it with cancellations would send them to change a
 * setting that was never the problem.
 */

export interface SpendSummary {
  totals: UsageTotals;
  taskCount: number;
  runCount: number;
  /** Runs a budget or the wall clock actually stopped. Never a cancelled one. */
  stoppedByBudget: number;
  cancelled: number;
  /** The most expensive task first; empty when nothing has been metered. */
  topTasks: Array<{ task: TaskSpend; totals: UsageTotals }>;
}

const STOPPED_BY_BUDGET: ReadonlySet<RunStatus> = new Set<RunStatus>(["budget_exhausted", "timed_out"]);

export function summarise(tasks: readonly TaskSpend[]): SpendSummary {
  const perTask = tasks.map((task) => ({ task, totals: sumUsage(task.runs) }));
  const everyRun = tasks.flatMap((task) => task.runs);

  return {
    totals: sumUsage(everyRun),
    taskCount: tasks.length,
    runCount: everyRun.length,
    // Both conditions, deliberately: the status is what the run loop decided,
    // and `budgetBreach` is the bound it decided on. A cancelled run has
    // neither, so it cannot be counted here by accident.
    stoppedByBudget: everyRun.filter((run) => STOPPED_BY_BUDGET.has(run.status) && run.budgetBreach !== null).length,
    cancelled: everyRun.filter((run) => run.status === "cancelled").length,
    topTasks: [...perTask].sort((a, b) => b.totals.costUsd - a.totals.costUsd),
  };
}
