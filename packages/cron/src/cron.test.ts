import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidCronError,
  describeCron,
  isValidTimezone,
  nextCronRun,
  nextCronRuns,
  normalizeCron,
  validateCron,
} from "./cron.js";

/**
 * The scheduler's arithmetic, tested where it is cheap to test.
 *
 * Everything here is pure and every input is a fixed instant, so these run in
 * milliseconds with no database, no clock dependency and -- the reason the
 * timezone cases exist at all -- no dependence on the machine's own TZ.
 */

describe("normalizeCron", () => {
  it("keeps a five-field expression, collapsing whitespace", () => {
    assert.equal(normalizeCron("  0   9  *  *  1-5 "), "0 9 * * 1-5");
  });

  it("expands the nicknames people reach for", () => {
    assert.equal(normalizeCron("@daily"), "0 0 * * *");
    assert.equal(normalizeCron("@HOURLY"), "0 * * * *");
    assert.equal(normalizeCron("@weekly"), "0 0 * * 0");
  });

  it("refuses a six-field expression rather than accepting seconds", () => {
    // croner itself would take this. We do not: the tick is 30s and next_run_at
    // is a timestamp, so a per-second schedule is either missed or a hammer.
    assert.throws(() => normalizeCron("*/5 * * * * *"), InvalidCronError);
  });

  it("refuses an unknown nickname by name", () => {
    assert.throws(
      () => normalizeCron("@fortnightly"),
      (error: unknown) => error instanceof InvalidCronError && /@hourly/.test((error as Error).message),
    );
  });

  it("refuses an empty expression", () => {
    assert.throws(() => normalizeCron("   "), InvalidCronError);
  });
});

describe("nextCronRun", () => {
  it("is strictly after `from`, so a boundary-exact tick cannot fire twice", () => {
    // 09:00 UTC exactly, asking for the next daily-at-09:00.
    const boundary = new Date("2026-03-10T09:00:00.000Z");
    const next = nextCronRun("0 9 * * *", "UTC", boundary);
    assert.equal(next.toISOString(), "2026-03-11T09:00:00.000Z");
  });

  it("resolves the hour in the job's timezone, not the host's", () => {
    // 09:00 in New York is 13:00 UTC while EDT is in force.
    const from = new Date("2026-06-01T00:00:00.000Z");
    assert.equal(nextCronRun("0 9 * * *", "America/New_York", from).toISOString(), "2026-06-01T13:00:00.000Z");
    // ...and 14:00 UTC in the same place in January, when it is EST.
    const winter = new Date("2026-01-01T00:00:00.000Z");
    assert.equal(nextCronRun("0 9 * * *", "America/New_York", winter).toISOString(), "2026-01-01T14:00:00.000Z");
  });

  it("follows a DST spring-forward: the wall-clock hour is what is honoured", () => {
    // Europe/London goes 01:00 -> 02:00 BST on 2026-03-29. A 09:00 job runs at
    // 09:00 local either side, which is 09:00 UTC before and 08:00 UTC after.
    const before = nextCronRun("0 9 * * *", "Europe/London", new Date("2026-03-28T12:00:00.000Z"));
    assert.equal(before.toISOString(), "2026-03-29T08:00:00.000Z");
    const after = nextCronRun("0 9 * * *", "Europe/London", new Date("2026-03-29T12:00:00.000Z"));
    assert.equal(after.toISOString(), "2026-03-30T08:00:00.000Z");
  });

  it("handles a day-of-week schedule", () => {
    // 2026-03-10 is a Tuesday; the next Monday 09:00 UTC is the 16th.
    const next = nextCronRun("0 9 * * 1", "UTC", new Date("2026-03-10T12:00:00.000Z"));
    assert.equal(next.toISOString(), "2026-03-16T09:00:00.000Z");
  });

  it("refuses a timezone this platform does not know", () => {
    assert.throws(
      () => nextCronRun("0 9 * * *", "Mars/Olympus_Mons", new Date()),
      (error: unknown) => error instanceof InvalidCronError && /IANA/.test((error as Error).message),
    );
  });

  it("refuses an expression that parses but can never happen", () => {
    // 30 February. croner parses it happily and then never yields anything.
    assert.throws(
      () => nextCronRun("0 0 30 2 *", "UTC", new Date("2026-01-01T00:00:00.000Z")),
      (error: unknown) => error instanceof InvalidCronError && /never run/.test((error as Error).message),
    );
  });

  it("refuses garbage rather than silently scheduling something else", () => {
    assert.throws(() => nextCronRun("nonsense here at all", "UTC", new Date()), InvalidCronError);
    assert.throws(() => nextCronRun("99 * * * *", "UTC", new Date()), InvalidCronError);
  });
});

describe("nextCronRuns", () => {
  it("walks forward without repeating an occurrence", () => {
    const runs = nextCronRuns("*/15 * * * *", "UTC", 4, new Date("2026-03-10T09:00:00.000Z"));
    assert.deepEqual(
      runs.map((d) => d.toISOString()),
      [
        "2026-03-10T09:15:00.000Z",
        "2026-03-10T09:30:00.000Z",
        "2026-03-10T09:45:00.000Z",
        "2026-03-10T10:00:00.000Z",
      ],
    );
  });
});

describe("validateCron", () => {
  it("returns the canonical expression together with the first occurrence", () => {
    const result = validateCron("@daily", "Europe/London", new Date("2026-06-01T12:00:00.000Z"));
    assert.equal(result.expression, "0 0 * * *");
    assert.equal(result.timezone, "Europe/London");
    // Midnight London in June is 23:00 UTC the previous day.
    assert.equal(result.next.toISOString(), "2026-06-01T23:00:00.000Z");
  });

  it("rejects the timezone before it looks at the expression", () => {
    assert.throws(
      () => validateCron("this is not cron", "Nowhere/Special"),
      (error: unknown) => error instanceof InvalidCronError && /IANA/.test((error as Error).message),
    );
  });
});

describe("isValidTimezone", () => {
  it("accepts real IANA names and rejects invented ones", () => {
    assert.equal(isValidTimezone("UTC"), true);
    assert.equal(isValidTimezone("America/Sao_Paulo"), true);
    assert.equal(isValidTimezone("Europe/Not_A_Place"), false);
    assert.equal(isValidTimezone(""), false);
  });
});

describe("describeCron", () => {
  it("glosses the shapes people actually write", () => {
    assert.equal(describeCron("*/5 * * * *"), "Every 5 minutes");
    assert.equal(describeCron("0 * * * *"), "Hourly at 00 past");
    assert.equal(describeCron("30 */6 * * *"), "Every 6 hours at 30 past");
    assert.equal(describeCron("0 9 * * *"), "Daily at 09:00");
    assert.equal(describeCron("0 9 * * 1-5"), "Weekdays at 09:00");
    assert.equal(describeCron("15 6 * * 1"), "Weekly on Monday at 06:15");
    assert.equal(describeCron("0 3 1 * *"), "Monthly on day 1 at 03:00");
    assert.equal(describeCron("@daily"), "Daily at 00:00");
  });

  it("returns null rather than inventing a worse sentence", () => {
    assert.equal(describeCron("0 9 1,15 * 3"), null);
    assert.equal(describeCron("not cron"), null);
  });
});
