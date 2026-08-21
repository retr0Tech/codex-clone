import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunMeterSnapshot } from "../gateway/metering.js";
import { RunDeadline, wallClockReason, type DeadlineTimers } from "./deadline.js";
import { RunController, decideOutcome, type FinalizeContext } from "./supervisor.js";

/**
 * The two halves of "a run that runs out of time stops, and says so".
 *
 * Neither needs Docker, Postgres or a model: the timer is injected and the
 * outcome decision is a pure function of what the host observed. That matters
 * more than convenience -- these are the paths that only fire when something
 * has already gone wrong, so they are the ones that rot if they only run in a
 * suite that skips wherever Docker is absent.
 */

/** A clock the test drives by hand, so a 20-minute bound takes no time at all. */
function fakeTimers() {
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; at: number }>();
  let now = 0;

  const timers: DeadlineTimers = {
    set(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };

  return {
    timers,
    get pendingCount() {
      return pending.size;
    },
    advance(ms: number) {
      now += ms;
      for (const [id, entry] of [...pending]) {
        if (entry.at <= now) {
          pending.delete(id);
          entry.fn();
        }
      }
    },
  };
}

describe("RunDeadline", () => {
  it("fires once the wall clock is up", () => {
    const clock = fakeTimers();
    let fired = 0;
    const deadline = RunDeadline.arm(1_000, () => (fired += 1), clock.timers);

    clock.advance(999);
    assert.equal(fired, 0, "it must not fire early");
    clock.advance(1);
    assert.equal(fired, 1);
    assert.equal(deadline.fired, true);
    assert.equal(deadline.armed, false, "a fired deadline holds no timer");
  });

  it("does not fire after cancel, and cancelling twice is harmless", () => {
    const clock = fakeTimers();
    let fired = 0;
    const deadline = RunDeadline.arm(1_000, () => (fired += 1), clock.timers);

    deadline.cancel();
    deadline.cancel();
    assert.equal(clock.pendingCount, 0, "the timer must be released, not merely ignored");

    clock.advance(10_000);
    assert.equal(fired, 0);
    assert.equal(deadline.fired, false);
  });

  it("disarms rather than firing immediately on a nonsensical bound", () => {
    // A misconfigured ceiling should not kill every run the moment it starts.
    for (const ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const clock = fakeTimers();
      let fired = 0;
      const deadline = RunDeadline.arm(ms, () => (fired += 1), clock.timers);
      clock.advance(60_000);
      assert.equal(fired, 0, `wallClockMs=${ms} should disarm`);
      assert.equal(deadline.armed, false);
    }
  });

  it("says how long it waited, in the units a human reads", () => {
    assert.equal(wallClockReason(20 * 60_000), "the wall-clock limit of 20m was reached; the sandbox was stopped");
    assert.match(wallClockReason(2_500), /limit of 3s/);
  });
});

/* -------------------------------------------------------------------------- */

function snapshot(over: Partial<RunMeterSnapshot> = {}): RunMeterSnapshot {
  return {
    runId: "run_1",
    turns: 4,
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 20,
    costUsd: 0.25,
    elapsedMs: 5_000,
    state: "closed",
    breach: null,
    cancelled: false,
    closedReason: null,
    budget: { maxTurns: 40, maxCostUsd: 1, wallClockMs: 1_200_000 },
    ...over,
  };
}

function context(over: Partial<FinalizeContext> = {}): FinalizeContext {
  return {
    handle: null,
    agentStatus: null,
    failure: null,
    controller: new RunController(),
    emit: async () => undefined,
    ...over,
  };
}

describe("decideOutcome", () => {
  it("reports a cancelled run as cancelled, with no budget breach", () => {
    const controller = new RunController();
    controller.markCancelled("cancelled from the UI");

    // The agent, refused mid-turn, said `budget_exhausted` on its way out. That
    // is a symptom of the stop, not an account of it.
    const outcome = decideOutcome(
      context({ controller, agentStatus: { status: "budget_exhausted", reason: "gateway refused" } }),
      snapshot({ cancelled: true, closedReason: "cancelled from the UI" }),
    );

    assert.equal(outcome.status, "cancelled");
    assert.equal(outcome.stopReason, "cancelled from the UI");
    assert.equal(outcome.budgetBreach, null, "a cancelled run must never be recorded as a budget breach");
  });

  it("still reports cancelled when a bound really had been hit first", () => {
    const controller = new RunController();
    controller.markCancelled("cancelled from the UI");
    const outcome = decideOutcome(context({ controller }), snapshot({ cancelled: true, breach: "max_cost" }));
    assert.equal(outcome.status, "cancelled");
    assert.equal(outcome.budgetBreach, null);
  });

  it("reports a run the wall clock stopped as timed_out", () => {
    const controller = new RunController();
    controller.markTimedOut(wallClockReason(1_000));

    const outcome = decideOutcome(
      context({ controller, agentStatus: { status: "budget_exhausted", reason: "gateway refused" } }),
      snapshot({ breach: "wall_clock" }),
    );

    assert.equal(outcome.status, "timed_out", "a run that ran out of time is not a run that ran out of budget");
    assert.equal(outcome.budgetBreach, "wall_clock");
    assert.match(outcome.stopReason ?? "", /wall-clock limit/);
  });

  it("cancel outranks the deadline: the user's reason is the one they get", () => {
    const controller = new RunController();
    controller.markCancelled("cancelled from the UI");
    controller.markTimedOut(wallClockReason(1_000));
    assert.equal(decideOutcome(context({ controller }), snapshot()).status, "cancelled");
  });

  it("names the bound a budget-exhausted run actually hit", () => {
    const cost = decideOutcome(
      context({ agentStatus: { status: "budget_exhausted", reason: "refused" } }),
      snapshot({ breach: "max_cost", turns: 12, costUsd: 1.0004 }),
    );
    assert.equal(cost.status, "budget_exhausted");
    assert.equal(cost.budgetBreach, "max_cost");
    assert.match(cost.stopReason ?? "", /cost ceiling was reached after 12 turns and \$1\.0004/);

    const turns = decideOutcome(
      context({ agentStatus: { status: "budget_exhausted", reason: "refused" } }),
      snapshot({ breach: "max_turns" }),
    );
    assert.equal(turns.budgetBreach, "max_turns");
    assert.match(turns.stopReason ?? "", /turn ceiling/);
  });

  it("maps a wall-clock breach the meter caught to timed_out too", () => {
    // The gateway refused the agent's next call because the wall clock was up,
    // and the agent wound down politely -- no host deadline was involved.
    const outcome = decideOutcome(
      context({ agentStatus: { status: "budget_exhausted", reason: "refused" } }),
      snapshot({ breach: "wall_clock" }),
    );
    assert.equal(outcome.status, "timed_out");
    assert.equal(outcome.budgetBreach, "wall_clock");
  });

  it("passes an ordinary terminal status through untouched", () => {
    const outcome = decideOutcome(
      context({ agentStatus: { status: "succeeded", reason: "finished in 6 turns" } }),
      snapshot(),
    );
    assert.deepEqual(outcome, { status: "succeeded", stopReason: "finished in 6 turns", budgetBreach: null });
  });

  it("never leaves a run looking like it is still working", () => {
    const outcome = decideOutcome(context(), null);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.stopReason ?? "", /without reporting a status/);
    assert.equal(outcome.budgetBreach, null);
  });

  it("prefers a host-observed failure over the agent's account", () => {
    const outcome = decideOutcome(
      context({ failure: "the volume disappeared", agentStatus: { status: "succeeded", reason: null } }),
      snapshot(),
    );
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.budgetBreach, null);
  });
});
