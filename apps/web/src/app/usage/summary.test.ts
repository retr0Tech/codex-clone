import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunView } from "../../lib/types";
import type { TaskSpend } from "./data";
import { summarise } from "./summary";

function run(over: Partial<RunView> = {}): RunView {
  return {
    id: `run_${Math.random().toString(16).slice(2, 8)}`,
    prompt: "p",
    status: "succeeded",
    phase: "done",
    stopReason: null,
    budgetBreach: null,
    turns: 2,
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 10,
    costUsd: 0.001,
    startedAt: "2026-08-20T10:00:00.000Z",
    endedAt: "2026-08-20T10:00:30.000Z",
    createdAt: "2026-08-20T10:00:00.000Z",
    ...over,
  };
}

function task(id: string, runs: RunView[], over: Partial<TaskSpend> = {}): TaskSpend {
  return {
    taskId: id,
    title: id,
    repoFullName: "fixture/repo",
    archived: false,
    runs,
    lastRunAt: "2026-08-20T10:00:00.000Z",
    ...over,
  };
}

describe("the spend summary", () => {
  it("totals across every task and run", () => {
    const summary = summarise([
      task("a", [run(), run({ costUsd: 0.002 })]),
      task("b", [run({ costUsd: 0.5, turns: 30 })]),
    ]);

    assert.equal(summary.taskCount, 2);
    assert.equal(summary.runCount, 3);
    assert.equal(summary.totals.turns, 34);
    assert.ok(Math.abs(summary.totals.costUsd - 0.503) < 1e-9);
    assert.equal(summary.totals.cachedInputTokens, 60);
  });

  it("puts the most expensive task first", () => {
    const summary = summarise([task("cheap", [run({ costUsd: 0.001 })]), task("dear", [run({ costUsd: 0.9 })])]);
    assert.deepEqual(summary.topTasks.map((t) => t.task.taskId), ["dear", "cheap"]);
  });

  /**
   * The number someone reads before deciding to raise a ceiling. Counting
   * cancellations in it would send them to change a setting that was never the
   * problem.
   */
  it("counts only runs a bound actually stopped", () => {
    const summary = summarise([
      task("a", [
        run({ status: "budget_exhausted", budgetBreach: "max_cost" }),
        run({ status: "timed_out", budgetBreach: "wall_clock" }),
        // Cancelled at 39 of 40 turns and a hair under the cost ceiling: the
        // numbers look exactly like a breach, and it is not one.
        run({ status: "cancelled", budgetBreach: null, turns: 39, costUsd: 0.99 }),
        run({ status: "failed" }),
        run({ status: "succeeded" }),
      ]),
    ]);

    assert.equal(summary.stoppedByBudget, 2);
    assert.equal(summary.cancelled, 1);
  });

  it("ignores a status that claims a bound without one recorded", () => {
    // Belt and braces against an older row, or a status written by something
    // that did not know which bound it hit.
    const summary = summarise([task("a", [run({ status: "budget_exhausted", budgetBreach: null })])]);
    assert.equal(summary.stoppedByBudget, 0);
  });

  it("summarises an empty install to zeroes, not to NaN", () => {
    const summary = summarise([]);
    assert.equal(summary.runCount, 0);
    assert.equal(summary.totals.costUsd, 0);
    assert.deepEqual(summary.topTasks, []);
  });
});
