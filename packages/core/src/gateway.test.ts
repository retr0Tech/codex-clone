import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BREACH_LABEL,
  BUDGET_FIELDS,
  DEFAULT_BUDGET,
  budgetProblem,
  checkBudget,
  type RunBudget,
} from "./gateway.js";

/**
 * The budget contract. It is shared by the gateway (which enforces it), the
 * Settings API (which accepts an edit to it) and the UI (which renders how
 * close a run came to it), so the three cannot be allowed to disagree about
 * what a valid budget is or what a breach is called.
 */

describe("checkBudget", () => {
  const budget: RunBudget = { maxTurns: 3, maxCostUsd: 0.5, wallClockMs: 1_000 };

  it("is quiet while every bound has headroom", () => {
    assert.equal(checkBudget(budget, { turns: 2, costUsd: 0.49, elapsedMs: 999 }), null);
  });

  it("reports the bound that was actually hit", () => {
    assert.equal(checkBudget(budget, { turns: 3, costUsd: 0, elapsedMs: 0 }), "max_turns");
    assert.equal(checkBudget(budget, { turns: 0, costUsd: 0.5, elapsedMs: 0 }), "max_cost");
    assert.equal(checkBudget(budget, { turns: 0, costUsd: 0, elapsedMs: 1_000 }), "wall_clock");
  });

  it("names turns first when several bounds are past at once", () => {
    // Arbitrary but fixed: the wind-down message quotes one bound, and which
    // one it quotes must not depend on evaluation order changing.
    assert.equal(checkBudget(budget, { turns: 9, costUsd: 9, elapsedMs: 9_000 }), "max_turns");
  });
});

describe("budgetProblem", () => {
  it("accepts the shipped default", () => {
    assert.equal(budgetProblem(DEFAULT_BUDGET), null);
  });

  it("refuses a budget outside the offered range", () => {
    assert.match(budgetProblem({ ...DEFAULT_BUDGET, maxTurns: 0 }) ?? "", /Max turns/);
    assert.match(budgetProblem({ ...DEFAULT_BUDGET, maxCostUsd: 1_000 }) ?? "", /Max cost/);
    assert.match(budgetProblem({ ...DEFAULT_BUDGET, wallClockMs: 5 }) ?? "", /Wall clock/);
  });

  it("refuses a fractional turn count and a non-number", () => {
    assert.match(budgetProblem({ ...DEFAULT_BUDGET, maxTurns: 2.5 }) ?? "", /whole number/);
    assert.match(budgetProblem({ ...DEFAULT_BUDGET, maxCostUsd: Number.NaN }) ?? "", /must be a number/);
  });

  it("covers every field of RunBudget, so a new bound cannot ship unvalidated", () => {
    assert.deepEqual(
      BUDGET_FIELDS.map((f) => f.key).sort(),
      Object.keys(DEFAULT_BUDGET).sort(),
    );
  });
});

describe("BREACH_LABEL", () => {
  it("has one wording per bound", () => {
    assert.deepEqual(Object.keys(BREACH_LABEL).sort(), ["max_cost", "max_turns", "wall_clock"]);
  });
});
