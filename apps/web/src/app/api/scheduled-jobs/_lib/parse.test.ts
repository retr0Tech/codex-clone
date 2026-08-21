import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidScheduledJobError,
  MAX_NAME_LENGTH,
  MAX_PROMPT_BYTES,
  parseCreateScheduledJob,
  parseUpdateScheduledJob,
} from "./parse.js";

/**
 * The door a scheduled job has to get through.
 *
 * Worth testing more carefully than most validators: a bad cron expression
 * accepted here does not fail now, it fails at 3am in a worker nobody is
 * watching. So the expression is resolved to a real first occurrence at
 * validation time, and these assert that it is.
 *
 * Pure -- no database, no network, no clock of its own.
 */

const NOW = new Date("2026-08-21T12:00:00.000Z");

const VALID = {
  name: "Nightly dependency audit",
  repoFullName: "retr0Tech/repoTest",
  baseBranch: "main",
  prompt: "check for outdated dependencies and update them",
  cronExpr: "0 3 * * *",
  timezone: "Europe/London",
};

describe("parseCreateScheduledJob", () => {
  it("accepts a complete job and computes its first occurrence", () => {
    const input = parseCreateScheduledJob(VALID, NOW);
    assert.equal(input.name, "Nightly dependency audit");
    assert.equal(input.cronExpr, "0 3 * * *");
    assert.equal(input.timezone, "Europe/London");
    // 03:00 London on 22 August is 02:00 UTC: the timezone is honoured, not
    // decorative, and the row is never written without a next_run_at.
    assert.equal(input.nextRunAt.toISOString(), "2026-08-22T02:00:00.000Z");
  });

  it("defaults the options the way an unattended job should default", () => {
    const input = parseCreateScheduledJob(VALID, NOW);
    assert.equal(input.enabled, true);
    assert.equal(input.onOverlap, "skip");
    assert.equal(input.catchup, true);
    // An unattended diff that dies with its container is worthless, so pushing
    // is on by default and opening a pull request is not.
    assert.equal(input.autoPushBranch, true);
    assert.equal(input.autoOpenPr, false);
  });

  it("canonicalises a nickname so the stored expression has one shape", () => {
    const input = parseCreateScheduledJob({ ...VALID, cronExpr: "@daily", timezone: "UTC" }, NOW);
    assert.equal(input.cronExpr, "0 0 * * *");
    assert.equal(input.nextRunAt.toISOString(), "2026-08-22T00:00:00.000Z");
  });

  it("falls back to the first line of the prompt when no name is given", () => {
    const input = parseCreateScheduledJob({ ...VALID, name: "   " }, NOW);
    assert.equal(input.name, "check for outdated dependencies and update them");
  });

  it("rejects a cron expression that would never fire", () => {
    assert.throws(
      () => parseCreateScheduledJob({ ...VALID, cronExpr: "every night please" }, NOW),
      (error: unknown) => error instanceof InvalidScheduledJobError && /5 fields/.test((error as Error).message),
    );
  });

  it("rejects a timezone that does not exist", () => {
    assert.throws(
      () => parseCreateScheduledJob({ ...VALID, timezone: "Europe/Nowhere" }, NOW),
      (error: unknown) => error instanceof InvalidScheduledJobError && /IANA/.test((error as Error).message),
    );
  });

  it("rejects a pull request with no branch to open it from", () => {
    assert.throws(
      () => parseCreateScheduledJob({ ...VALID, autoOpenPr: true, autoPushBranch: false }, NOW),
      (error: unknown) => error instanceof InvalidScheduledJobError && /needs a branch/.test((error as Error).message),
    );
  });

  it("rejects the fields a schedule cannot do without", () => {
    for (const missing of ["repoFullName", "baseBranch", "prompt", "cronExpr"]) {
      const body: Record<string, unknown> = { ...VALID };
      delete body[missing];
      assert.throws(
        () => parseCreateScheduledJob(body, NOW),
        (error: unknown) => error instanceof InvalidScheduledJobError,
        `${missing} should be required`,
      );
    }
  });

  it("rejects a repo name and a branch name that are not usable as such", () => {
    assert.throws(() => parseCreateScheduledJob({ ...VALID, repoFullName: "justaname" }, NOW), InvalidScheduledJobError);
    assert.throws(() => parseCreateScheduledJob({ ...VALID, baseBranch: "feat..x" }, NOW), InvalidScheduledJobError);
    assert.throws(() => parseCreateScheduledJob({ ...VALID, baseBranch: "-dash" }, NOW), InvalidScheduledJobError);
  });

  it("caps the prompt and the name", () => {
    assert.throws(
      () => parseCreateScheduledJob({ ...VALID, prompt: "x".repeat(MAX_PROMPT_BYTES + 1) }, NOW),
      InvalidScheduledJobError,
    );
    assert.throws(
      () => parseCreateScheduledJob({ ...VALID, name: "n".repeat(MAX_NAME_LENGTH + 1) }, NOW),
      InvalidScheduledJobError,
    );
  });

  it("rejects a body that is not an object", () => {
    for (const body of [null, [], "nope", 7]) {
      assert.throws(() => parseCreateScheduledJob(body, NOW), InvalidScheduledJobError);
    }
  });
});

describe("parseUpdateScheduledJob", () => {
  const current = { cronExpr: "0 3 * * *", timezone: "Europe/London" };

  it("returns only the keys that were sent", () => {
    assert.deepEqual(parseUpdateScheduledJob({ enabled: false }, current), { enabled: false });
    assert.deepEqual(parseUpdateScheduledJob({ catchup: false }, current), { catchup: false });
  });

  it("validates the schedule as a pair even when only one half changed", () => {
    // A timezone-only edit still has to be checked against the expression it
    // will actually run with; either field alone can produce a job that never
    // fires.
    const patch = parseUpdateScheduledJob({ timezone: "America/New_York" }, current);
    assert.equal(patch.timezone, "America/New_York");
    assert.equal(patch.cronExpr, "0 3 * * *", "the unchanged half comes along so both are stored consistently");

    assert.throws(
      () => parseUpdateScheduledJob({ timezone: "Mars/Base" }, current),
      InvalidScheduledJobError,
    );
    assert.throws(
      () => parseUpdateScheduledJob({ cronExpr: "0 0 30 2 *" }, current),
      (error: unknown) => error instanceof InvalidScheduledJobError && /never run/.test((error as Error).message),
    );
  });

  it("refuses an empty patch rather than pretending to have written something", () => {
    assert.throws(() => parseUpdateScheduledJob({}, current), InvalidScheduledJobError);
  });

  it("rejects a non-boolean toggle instead of coercing it", () => {
    assert.throws(() => parseUpdateScheduledJob({ enabled: "yes" }, current), InvalidScheduledJobError);
    assert.throws(() => parseUpdateScheduledJob({ onOverlap: "wait" }, current), InvalidScheduledJobError);
  });

  it("still refuses a pull request with no branch", () => {
    assert.throws(
      () => parseUpdateScheduledJob({ autoOpenPr: true, autoPushBranch: false }, current),
      InvalidScheduledJobError,
    );
  });
});
