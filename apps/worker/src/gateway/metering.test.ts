import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunBudget } from "@codex-clone/core";
import { MeterRegistry, RunMeter } from "./metering.js";
import { computeCost, PRICING, pricingFor, UNKNOWN_MODEL_PRICING } from "./pricing.js";

const budget: RunBudget = { maxTurns: 3, maxCostUsd: 1, wallClockMs: 60_000 };

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("RunMeter budget enforcement", () => {
  it("forwards while under every bound", () => {
    const meter = new RunMeter("run_1", budget, clock().now);
    assert.equal(meter.admit().action, "forward");
    assert.equal(meter.admit().action, "forward");
    assert.equal(meter.usage().turns, 2);
  });

  it("counts turns so maxTurns means exactly that many model calls", () => {
    const meter = new RunMeter("run_1", budget, clock().now);
    assert.equal(meter.admit().action, "forward");
    assert.equal(meter.admit().action, "forward");
    assert.equal(meter.admit().action, "forward");
    assert.equal(meter.usage().turns, 3);

    const fourth = meter.admit();
    assert.equal(fourth.action, "wind_down");
    assert.equal(fourth.action === "wind_down" && fourth.breach, "max_turns");
  });

  it("grants exactly ONE wind-down turn, then refuses", () => {
    const meter = new RunMeter("run_1", { ...budget, maxTurns: 1 }, clock().now);
    assert.equal(meter.admit().action, "forward");

    const second = meter.admit();
    assert.equal(second.action, "wind_down", "the breach turn must still reach the model, so it can summarise");

    const third = meter.admit();
    assert.equal(third.action, "refuse");
    assert.equal(third.action === "refuse" && third.breach, "max_turns");

    // And it stays refused.
    assert.equal(meter.admit().action, "refuse");
    assert.equal(meter.state, "closed");
  });

  it("breaches on cost", () => {
    const meter = new RunMeter("run_1", budget, clock().now);
    meter.admit();
    meter.record({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 1.5 });
    const next = meter.admit();
    assert.equal(next.action, "wind_down");
    assert.equal(next.action === "wind_down" && next.breach, "max_cost");
  });

  it("breaches on wall clock", () => {
    const c = clock();
    const meter = new RunMeter("run_1", budget, c.now);
    meter.admit();
    c.advance(61_000);
    const next = meter.admit();
    assert.equal(next.action, "wind_down");
    assert.equal(next.action === "wind_down" && next.breach, "wall_clock");
  });

  it("close() -- the cancel path -- refuses immediately with no wind-down turn", () => {
    const meter = new RunMeter("run_1", budget, clock().now);
    meter.admit();
    meter.close("wall_clock");
    const next = meter.admit();
    assert.equal(next.action, "refuse");
    assert.equal(next.action === "refuse" && next.breach, "wall_clock");
  });

  it("accumulates token counts across turns", () => {
    const meter = new RunMeter("run_1", budget, clock().now);
    meter.record({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, costUsd: 0.01 });
    meter.record({ inputTokens: 200, cachedInputTokens: 80, outputTokens: 20, costUsd: 0.02 });
    const s = meter.snapshot();
    assert.equal(s.inputTokens, 300);
    assert.equal(s.cachedInputTokens, 120);
    assert.equal(s.outputTokens, 30);
    assert.ok(Math.abs(s.costUsd - 0.03) < 1e-9);
  });
});

describe("MeterRegistry", () => {
  it("keeps one meter per run and forgets it on release", () => {
    const registry = new MeterRegistry(budget, clock().now);
    const a = registry.for("run_a");
    assert.equal(registry.for("run_a"), a, "the same run must reuse its meter or budgets reset every turn");
    assert.notEqual(registry.for("run_b"), a);
    assert.equal(registry.size, 2);

    a.admit();
    const snapshot = registry.release("run_a");
    assert.equal(snapshot?.turns, 1);
    assert.equal(registry.size, 1);
    assert.equal(registry.release("run_a"), null);
  });
});

describe("cost accounting", () => {
  it("bills uncached and cached input at their different rates", () => {
    const usage = computeCost("gpt-5", { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 });
    assert.ok(Math.abs(usage.costUsd - 1.25) < 1e-9);

    const cached = computeCost("gpt-5", { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 });
    assert.ok(Math.abs(cached.costUsd - 0.125) < 1e-9, "fully cached input must bill at the cached rate");
  });

  it("does not double-count cached tokens, which OpenAI reports as a subset of input", () => {
    const usage = computeCost("gpt-5", { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 0 });
    // 500k uncached at $1.25/M + 500k cached at $0.125/M
    assert.ok(Math.abs(usage.costUsd - (0.625 + 0.0625)) < 1e-9);
  });

  it("bills output tokens", () => {
    const usage = computeCost("gpt-5", { inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000 });
    assert.ok(Math.abs(usage.costUsd - 10) < 1e-9);
  });

  it("passes token counts through unchanged", () => {
    const usage = computeCost("gpt-5", { inputTokens: 7, cachedInputTokens: 3, outputTokens: 11 });
    assert.equal(usage.inputTokens, 7);
    assert.equal(usage.cachedInputTokens, 3);
    assert.equal(usage.outputTokens, 11);
  });

  it("matches a dated deployment id by its longest known prefix", () => {
    assert.deepEqual(pricingFor("gpt-5-mini-2025-08-07"), PRICING["gpt-5-mini"]);
    assert.deepEqual(pricingFor("gpt-5-2025-08-07"), PRICING["gpt-5"]);
  });

  it("bills an unknown model at the most expensive known rate, never at zero", () => {
    const pricing = pricingFor("some-model-we-have-never-heard-of");
    assert.deepEqual(pricing, UNKNOWN_MODEL_PRICING);
    const usage = computeCost("some-model-we-have-never-heard-of", {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
    });
    assert.ok(usage.costUsd > 0, "a missing price entry must not silently disable the cost budget");
  });
});
