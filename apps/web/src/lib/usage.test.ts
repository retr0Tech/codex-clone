import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunBudget } from "@codex-clone/core";
import {
  budgetGauges,
  budgetVerdict,
  cachedShare,
  formatDurationShort,
  formatTokens,
  formatUsd,
  percent,
  runElapsedMs,
  sumUsage,
  totalTokens,
  uncachedInputTokens,
} from "./usage";
import type { RunView } from "./types";

const BUDGET: RunBudget = { maxTurns: 40, maxCostUsd: 1, wallClockMs: 20 * 60_000 };

function run(over: Partial<RunView> = {}): RunView {
  return {
    id: "run_1",
    prompt: "do the thing",
    status: "succeeded",
    phase: "done",
    stopReason: null,
    budgetBreach: null,
    turns: 4,
    inputTokens: 1_000,
    cachedInputTokens: 400,
    outputTokens: 200,
    costUsd: 0.0025,
    startedAt: "2026-08-20T10:00:00.000Z",
    endedAt: "2026-08-20T10:01:00.000Z",
    createdAt: "2026-08-20T09:59:50.000Z",
    ...over,
  };
}

describe("token accounting", () => {
  it("treats cached input as a subset of input, never an addition", () => {
    const usage = sumUsage([run()]);
    assert.equal(usage.inputTokens, 1_000);
    assert.equal(usage.cachedInputTokens, 400);
    assert.equal(uncachedInputTokens(usage), 600);
    // Adding cached in would bill the run twice for exactly the tokens caching
    // is meant to make cheap.
    assert.equal(totalTokens(usage), 1_200);
  });

  it("reports the share of input the cache covered", () => {
    assert.equal(cachedShare(sumUsage([run()])), 0.4);
    assert.equal(cachedShare(sumUsage([run({ inputTokens: 0, cachedInputTokens: 0 })])), 0);
    // Defensive: a provider reporting more cached than input must not produce
    // a bar longer than the track.
    assert.equal(cachedShare(sumUsage([run({ inputTokens: 10, cachedInputTokens: 99 })])), 1);
  });

  it("adds up across the runs of a task", () => {
    const usage = sumUsage([run(), run({ id: "run_2", turns: 2, inputTokens: 500, cachedInputTokens: 100, outputTokens: 50, costUsd: 0.001 })]);
    assert.deepEqual(usage, {
      turns: 6,
      inputTokens: 1_500,
      cachedInputTokens: 500,
      outputTokens: 250,
      costUsd: 0.0035,
    });
  });

  it("sums an empty list to zero rather than to NaN", () => {
    assert.deepEqual(sumUsage([]), {
      turns: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });
});

describe("runElapsedMs", () => {
  it("measures from startedAt to endedAt", () => {
    assert.equal(runElapsedMs(run()), 60_000);
  });

  it("measures an unfinished run against now", () => {
    const now = Date.parse("2026-08-20T10:00:30.000Z");
    assert.equal(runElapsedMs(run({ endedAt: null, status: "running" }), now), 30_000);
  });

  it("falls back to createdAt when the run never recorded a start", () => {
    assert.equal(runElapsedMs(run({ startedAt: null })), 70_000);
  });

  it("never returns a negative duration", () => {
    assert.equal(runElapsedMs(run({ endedAt: "2026-08-20T09:00:00.000Z" })), 0);
  });
});

describe("budgetGauges", () => {
  it("reports how close each bound came", () => {
    const usage = sumUsage([run({ turns: 20, costUsd: 0.5 })]);
    const gauges = budgetGauges(BUDGET, usage, 10 * 60_000, null);

    assert.deepEqual(
      gauges.map((g) => [g.label, g.used, g.limit, g.ratio]),
      [
        ["Turns", "20", "40", 0.5],
        ["Cost", "$0.50", "$1.00", 0.5],
        ["Wall clock", "10m", "20m", 0.5],
      ],
    );
    assert.deepEqual(gauges.map((g) => g.hit), [false, false, false]);
  });

  it("marks the bound that actually stopped the run", () => {
    const gauges = budgetGauges(BUDGET, sumUsage([run()]), 0, "max_cost");
    assert.deepEqual(gauges.map((g) => g.hit), [false, true, false]);
  });

  it("clamps rather than overflowing when usage passed the bound", () => {
    const gauges = budgetGauges(BUDGET, sumUsage([run({ turns: 100 })]), 0, "max_turns");
    assert.equal(gauges[0]?.ratio, 1);
  });

  it("survives a nonsensical budget without dividing by zero", () => {
    const gauges = budgetGauges({ maxTurns: 0, maxCostUsd: 0, wallClockMs: 0 }, sumUsage([run()]), 5, null);
    assert.deepEqual(gauges.map((g) => g.ratio), [0, 0, 0]);
  });
});

describe("budgetVerdict", () => {
  const gaugesFor = (r: RunView, elapsedMs = 60_000) =>
    budgetGauges(BUDGET, sumUsage([r]), elapsedMs, r.budgetBreach);

  /**
   * The rule this whole module exists to keep. A cancelled run is frequently
   * cancelled *because* it was getting expensive, so the numbers alone would
   * happily call it a breach -- and that is a lie in the one place the user is
   * looking for the consequence of their own click.
   */
  it("never calls a cancelled run a budget breach, even at the edge of a bound", () => {
    const cancelled = run({ status: "cancelled", turns: 39, costUsd: 0.99, budgetBreach: null });
    const verdict = budgetVerdict(cancelled, gaugesFor(cancelled, 19 * 60_000));
    assert.equal(verdict.kind, "cancelled");
    assert.match(verdict.text, /Not a budget breach/);
    assert.doesNotMatch(verdict.text, /ceiling|limit was reached/);
  });

  it("names the bound for a run a budget really did stop", () => {
    const stopped = run({ status: "budget_exhausted", budgetBreach: "max_cost", costUsd: 1.02 });
    const verdict = budgetVerdict(stopped, gaugesFor(stopped));
    assert.equal(verdict.kind, "stopped");
    assert.match(verdict.text, /the cost ceiling was reached/);
  });

  it("distinguishes a timed-out run from an exhausted one", () => {
    const timedOut = run({ status: "timed_out", budgetBreach: "wall_clock" });
    const verdict = budgetVerdict(timedOut, gaugesFor(timedOut, 20 * 60_000));
    assert.equal(verdict.kind, "stopped");
    assert.match(verdict.text, /wall-clock limit/);
  });

  it("flags a run that finished with almost no headroom", () => {
    const tight = run({ turns: 39 });
    const verdict = budgetVerdict(tight, gaugesFor(tight));
    assert.equal(verdict.kind, "near");
    assert.match(verdict.text, /little headroom/);
    assert.match(verdict.text, /turn ceiling/);
  });

  it("says so plainly when a run was nowhere near a bound", () => {
    const roomy = run({ turns: 2, costUsd: 0.0001 });
    const verdict = budgetVerdict(roomy, gaugesFor(roomy, 30_000));
    assert.equal(verdict.kind, "clear");
    assert.match(verdict.text, /well inside every bound/);
  });

  it("does not judge a run that is still going", () => {
    const live = run({ status: "running", endedAt: null });
    assert.equal(budgetVerdict(live, gaugesFor(live)).kind, "pending");
  });
});

describe("formatting", () => {
  it("keeps sub-cent spend visible instead of rounding it to zero", () => {
    // Every real run in this project so far has cost less than a cent; two
    // decimals would show the entire cost panel as $0.00.
    assert.equal(formatUsd(0.004697), "$0.0047");
    assert.equal(formatUsd(0.0001), "$0.0001");
    assert.equal(formatUsd(0.25), "$0.25");
    assert.equal(formatUsd(1.2), "$1.20");
    assert.equal(formatUsd(0), "$0.00");
    assert.equal(formatUsd(Number.NaN), "$0.00");
  });

  it("abbreviates token counts", () => {
    assert.equal(formatTokens(834), "834");
    assert.equal(formatTokens(1_000), "1k");
    assert.equal(formatTokens(12_400), "12.4k");
    assert.equal(formatTokens(2_500_000), "2.5M");
  });

  it("does not round a small share down to nothing", () => {
    assert.equal(percent(0.0004), "<1%");
    assert.equal(percent(0), "0%");
    assert.equal(percent(0.5), "50%");
    assert.equal(percent(1), "100%");
  });

  it("renders a budget's wall clock the way it was configured", () => {
    assert.equal(formatDurationShort(20 * 60_000), "20m");
    assert.equal(formatDurationShort(90 * 60_000), "1h 30m");
    assert.equal(formatDurationShort(2 * 60 * 60_000), "2h");
    assert.equal(formatDurationShort(45_000), "45s");
    assert.equal(formatDurationShort(0), "0s");
  });
});
