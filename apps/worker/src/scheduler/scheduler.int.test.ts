import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { asc, eq, inArray } from "drizzle-orm";
import {
  createDb,
  repos,
  runs,
  scheduledExecutions,
  scheduledJobs,
  tasks,
  type Database,
} from "@codex-clone/db";
import type { PublishOptions, PublishResult } from "../runner/publish.js";
import { PublishError } from "../runner/publish.js";
import { TEST_DATABASE_URL, postgresUnavailable, withTimeout } from "../runner/testing.js";
import { claimDueJobs } from "./claim.js";
import { scheduledBranchName } from "./execute.js";
import { NoSuchJobError, RunNowError, Scheduler, type TickResult } from "./scheduler.js";
import type { SchedulerDeps } from "./types.js";

/**
 * The scheduler against a real Postgres, with no Docker and no model.
 *
 * Everything the scheduler guarantees is a database guarantee -- the claim, the
 * overlap decision, firing once after downtime, the fact that two workers
 * cannot double-fire -- so all of it is testable here, in milliseconds, with
 * the run itself stubbed out by writing the terminal status the supervisor
 * would have written. `scheduled-run.int.test.ts` is the one that puts a real
 * container on the other end.
 *
 * No test in this file can reach a model provider or github.com: the base SHA
 * resolver and the publish path are both injected fakes, which is the same
 * seam the run loop's own integration test uses.
 *
 * Skips with a reason when Postgres is absent. Every wait is bounded.
 */

const TEST_TIMEOUT_MS = 30_000;
const skip = await postgresUnavailable();

describe(
  "the scheduler: claim, overlap, catch-up, and settling",
  { skip: skip === false ? undefined : skip },
  () => {
    let db: Database;
    let closeDb: () => Promise<unknown>;
    const repoIds: string[] = [];
    const jobIds: string[] = [];

    before(async () => {
      ({ db, close: closeDb } = createDb(TEST_DATABASE_URL));
      await withTimeout(db.execute("select 1"), 10_000, "connecting to Postgres");
    });

    after(async () => {
      if (db) {
        // Tasks cascade to runs and events; jobs cascade to executions. The
        // task rows a job created are NOT cascaded from the job, so they are
        // collected explicitly -- a test that leaves rows behind makes the next
        // developer's `/scheduled` page a museum of someone else's fixtures.
        for (const jobId of jobIds) {
          const created = await db
            .select({ taskId: scheduledExecutions.taskId })
            .from(scheduledExecutions)
            .where(eq(scheduledExecutions.jobId, jobId))
            .catch(() => []);
          const taskIds = created.map((r) => r.taskId).filter((id): id is string => id !== null);
          if (taskIds.length > 0) {
            await db.delete(tasks).where(inArray(tasks.id, taskIds)).catch(() => undefined);
          }
          await db.delete(scheduledJobs).where(eq(scheduledJobs.id, jobId)).catch(() => undefined);
        }
        for (const repoId of repoIds) {
          await db.delete(repos).where(eq(repos.id, repoId)).catch(() => undefined);
        }
      }
      await closeDb?.().catch(() => undefined);
    });

    /** A repository row. The scheduler never talks to GitHub in these tests. */
    async function seedRepo(): Promise<string> {
      const suffix = randomUUID().slice(0, 8);
      const repoId = `repo-m9-${suffix}`;
      await db.insert(repos).values({
        id: repoId,
        owner: "fixture",
        name: `sched-${suffix}`,
        fullName: `fixture/sched-${suffix}`,
        defaultBranch: "main",
      });
      repoIds.push(repoId);
      return repoId;
    }

    interface JobOverrides {
      cronExpr?: string;
      timezone?: string;
      onOverlap?: "skip" | "queue";
      catchup?: boolean;
      autoPushBranch?: boolean;
      autoOpenPr?: boolean;
      enabled?: boolean;
      nextRunAt: Date;
      name?: string;
    }

    /**
     * Seeds a job, first switching off every job an earlier test created.
     *
     * The claim is deliberately global -- it is a worker's tick, not a test
     * fixture -- so without this, test N's tick would re-fire test N-1's job
     * the moment its clock moved past that job's advanced `next_run_at`. The
     * result assertions below are ALSO scoped by job id, because a developer's
     * database can hold real schedules that this suite has no business firing.
     */
    async function seedJob(overrides: JobOverrides): Promise<string> {
      if (jobIds.length > 0) {
        await db.update(scheduledJobs).set({ enabled: false }).where(inArray(scheduledJobs.id, jobIds));
      }
      const repoId = await seedRepo();
      const jobId = `job-m9-${randomUUID().slice(0, 8)}`;
      await db.insert(scheduledJobs).values({
        id: jobId,
        name: overrides.name ?? `nightly ${jobId.slice(-6)}`,
        repoId,
        prompt: "audit the dependencies and open a PR if anything is stale",
        baseBranch: "main",
        cronExpr: overrides.cronExpr ?? "*/5 * * * *",
        timezone: overrides.timezone ?? "UTC",
        enabled: overrides.enabled ?? true,
        onOverlap: overrides.onOverlap ?? "skip",
        catchup: overrides.catchup ?? true,
        autoPushBranch: overrides.autoPushBranch ?? false,
        autoOpenPr: overrides.autoOpenPr ?? false,
        nextRunAt: overrides.nextRunAt,
      });
      jobIds.push(jobId);
      return jobId;
    }

    function executionsOf(jobId: string) {
      return db
        .select()
        .from(scheduledExecutions)
        .where(eq(scheduledExecutions.jobId, jobId))
        .orderBy(asc(scheduledExecutions.createdAt));
    }

    /** One bounded tick, reported for one job only. */
    async function tick(h: Harness, jobId: string, label: string): Promise<TickResult> {
      return only(await withTimeout(h.scheduler.tick(), 10_000, label), jobId);
    }

    /** A tick's outcome, narrowed to one job. See the note on `seedJob`. */
    async function only(result: TickResult, jobId: string): Promise<TickResult> {
      const mine = new Set((await executionsOf(jobId)).map((e) => e.id));
      return {
        settled: result.settled.filter((s) => mine.has(s.executionId)),
        fired: result.fired.filter((f) => mine.has(f.executionId)),
        skipped: result.skipped.filter((s) => s.jobId === jobId),
        failed: result.failed.filter((f) => f.jobId === jobId),
      };
    }

    async function jobRow(jobId: string) {
      const [row] = await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, jobId)).limit(1);
      assert.ok(row, `job ${jobId} disappeared`);
      return row;
    }

    interface Harness {
      scheduler: Scheduler;
      publishes: Array<{ taskId: string; options: PublishOptions }>;
      setNow: (when: Date) => void;
      /** Makes the next publish call reject with this error. */
      failPublishWith: (error: Error | null) => void;
    }

    function harness(options: { now?: Date; catchupGraceMs?: number; staleClaimMs?: number } = {}): Harness {
      let clock = options.now ?? new Date();
      const publishes: Array<{ taskId: string; options: PublishOptions }> = [];
      let publishError: Error | null = null;

      const deps: SchedulerDeps = {
        db,
        // A fixed SHA: these tests are about scheduling, and a resolver that
        // reached github.com would make them a network test instead.
        resolveBaseSha: () => Promise.resolve("0".repeat(40)),
        publish: (taskId, opts) => {
          publishes.push({ taskId, options: opts });
          if (publishError) return Promise.reject(publishError);
          return Promise.resolve({
            branch: "scheduled/x/y",
            commit: "a".repeat(40),
            pushed: true,
            filesChanged: 2,
            branchUrl: "https://example.invalid/branch",
            compareUrl: "https://example.invalid/compare",
            repoFullName: "fixture/sched",
            baseBranch: "main",
            pullRequest: opts.openPullRequest
              ? {
                  number: 7,
                  url: "https://example.invalid/pull/7",
                  state: "open",
                  title: "scheduled",
                  head: "scheduled/x/y",
                  base: "main",
                  created: true,
                }
              : null,
          } satisfies PublishResult);
        },
        now: () => clock,
        log: () => undefined,
      };

      return {
        scheduler: new Scheduler({
          deps,
          tickMs: 30_000,
          claim: { catchupGraceMs: options.catchupGraceMs ?? 60_000 },
          settle: { staleClaimMs: options.staleClaimMs ?? 5 * 60 * 1000 },
        }),
        publishes,
        setNow: (when) => {
          clock = when;
        },
        failPublishWith: (error) => {
          publishError = error;
        },
      };
    }

    /** The terminal write the supervisor would have made, without a container. */
    async function finishRun(taskId: string, status: "succeeded" | "failed", stopReason: string | null = null) {
      await db
        .update(runs)
        .set({ status, phase: "done", stopReason, endedAt: new Date() })
        .where(eq(runs.taskId, taskId));
      await db.update(tasks).set({ status: "idle" }).where(eq(tasks.id, taskId));
    }

    it(
      "fires a due job once, records the execution, and puts next_run_at back in the future",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const now = new Date("2026-08-21T03:00:10.000Z");
        const jobId = await seedJob({ cronExpr: "*/5 * * * *", nextRunAt: new Date("2026-08-21T03:00:00.000Z") });
        const h = harness({ now });

        const result = await tick(h, jobId, "the first scheduler tick");
        assert.equal(result.fired.length, 1, `expected one fire, got ${JSON.stringify(result)}`);
        assert.equal(result.skipped.length, 0);
        assert.equal(result.failed.length, 0);

        const [execution] = await executionsOf(jobId);
        assert.ok(execution);
        assert.equal(execution.status, "running");
        assert.equal(execution.scheduledFor.toISOString(), "2026-08-21T03:00:00.000Z");
        assert.equal(execution.taskId, result.fired[0]?.taskId);

        // A brand-new task with a queued run, which is all the scheduler does:
        // the milestone 5 run loop takes it from here.
        const [task] = await db.select().from(tasks).where(eq(tasks.id, execution.taskId as string));
        assert.equal(task?.status, "queued");
        assert.equal(task?.baseBranch, "main");
        assert.equal(task?.baseSha, "0".repeat(40));
        // The volume is null, and that is the fresh-workspace guarantee: the
        // supervisor seeds from the mirror precisely when this is null, so a
        // scheduled execution has no warm workspace it COULD reuse.
        assert.equal(task?.volumeName, null, "a scheduled execution must start from a fresh workspace");
        assert.match(task?.workBranch ?? "", /^scheduled\//);

        const [run] = await db.select().from(runs).where(eq(runs.taskId, execution.taskId as string));
        assert.equal(run?.status, "queued");
        assert.equal(
          run?.scheduledExecutionId,
          execution.id,
          "the run must link back to its execution so the task page can say where it came from",
        );

        // next_run_at moved forward, so the very next tick finds nothing due.
        const job = await jobRow(jobId);
        assert.ok(job.nextRunAt > now, `next_run_at ${job.nextRunAt.toISOString()} should be after ${now.toISOString()}`);
        assert.equal(job.lastRunAt?.toISOString(), now.toISOString());

        const second = await tick(h, jobId, "the second scheduler tick");
        assert.equal(second.fired.length, 0, "a job that is not due must not fire again");
        assert.equal((await executionsOf(jobId)).length, 1);

        await finishRun(execution.taskId as string, "succeeded");
      },
    );

    it(
      "after downtime it fires ONCE, not once per missed occurrence",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        // Five hours of downtime on a five-minute schedule: sixty missed
        // occurrences. PLAN.md §3.5 says fire once on recovery, and the way
        // that is achieved is that next_run_at is recomputed from NOW rather
        // than stepped forward one occurrence at a time.
        const now = new Date("2026-08-21T08:00:00.000Z");
        const jobId = await seedJob({
          cronExpr: "*/5 * * * *",
          catchup: true,
          nextRunAt: new Date("2026-08-21T03:00:00.000Z"),
        });
        const h = harness({ now });

        const result = await tick(h, jobId, "the recovery tick");
        assert.equal(result.fired.length, 1, "sixty missed occurrences must produce exactly one run");

        const executions = await executionsOf(jobId);
        assert.equal(executions.length, 1, `expected 1 execution, got ${executions.length}`);
        // ...and it is recorded against the occurrence that was actually due.
        assert.equal(executions[0]?.scheduledFor.toISOString(), "2026-08-21T03:00:00.000Z");

        // Back on cadence: the next occurrence is the next five-minute mark
        // after now, not the next one after the stale value.
        const job = await jobRow(jobId);
        assert.equal(job.nextRunAt.toISOString(), "2026-08-21T08:05:00.000Z");

        await finishRun(executions[0]?.taskId as string, "succeeded");
      },
    );

    it(
      "with catch-up off, a missed occurrence is recorded as skipped rather than silently dropped",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const now = new Date("2026-08-21T08:00:00.000Z");
        const jobId = await seedJob({
          cronExpr: "*/5 * * * *",
          catchup: false,
          nextRunAt: new Date("2026-08-21T03:00:00.000Z"),
        });
        const h = harness({ now, catchupGraceMs: 60_000 });

        const result = await tick(h, jobId, "the no-catch-up tick");
        assert.equal(result.fired.length, 0);
        assert.equal(result.skipped.length, 1);

        const [execution] = await executionsOf(jobId);
        assert.equal(execution?.status, "skipped");
        assert.equal(execution?.taskId, null, "a skipped occurrence creates no workspace");
        assert.match(execution?.reason ?? "", /catch-up is off/);
        assert.match(execution?.reason ?? "", /5h/, `lateness should be stated: ${execution?.reason}`);

        // The schedule still moves on; a paused occurrence is not a stuck job.
        const job = await jobRow(jobId);
        assert.equal(job.nextRunAt.toISOString(), "2026-08-21T08:05:00.000Z");
        assert.equal(job.lastRunAt, null, "a skip is not a run");
      },
    );

    it(
      "a merely late tick still fires: lateness inside the grace window is not downtime",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const now = new Date("2026-08-21T03:00:40.000Z");
        const jobId = await seedJob({
          cronExpr: "*/5 * * * *",
          catchup: false,
          nextRunAt: new Date("2026-08-21T03:00:00.000Z"),
        });
        const h = harness({ now, catchupGraceMs: 60_000 });

        const result = await tick(h, jobId, "the slightly-late tick");
        assert.equal(result.fired.length, 1, "40s late is a slow tick, not a missed occurrence");
        await finishRun(result.fired[0]?.taskId as string, "succeeded");
      },
    );

    it(
      "on_overlap=skip records a skip with a reason while the previous execution is still running",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const now = new Date("2026-08-21T03:00:00.000Z");
        const jobId = await seedJob({
          cronExpr: "*/5 * * * *",
          onOverlap: "skip",
          nextRunAt: new Date("2026-08-21T02:59:59.000Z"),
        });
        const h = harness({ now });

        const first = await tick(h, jobId, "the first occurrence");
        assert.equal(first.fired.length, 1);
        const taskId = first.fired[0]?.taskId as string;

        // The next occurrence comes due while that run is still queued.
        h.setNow(new Date("2026-08-21T03:05:00.000Z"));
        await db
          .update(scheduledJobs)
          .set({ nextRunAt: new Date("2026-08-21T03:05:00.000Z") })
          .where(eq(scheduledJobs.id, jobId));

        const second = await tick(h, jobId, "the overlapping occurrence");
        assert.equal(second.fired.length, 0, "the second occurrence must not start a second workspace");
        assert.equal(second.skipped.length, 1);

        const executions = await executionsOf(jobId);
        assert.equal(executions.length, 2, "the skip is RECORDED, not dropped -- that is the whole point");
        assert.equal(executions[1]?.status, "skipped");
        assert.equal(executions[1]?.taskId, null);
        assert.match(executions[1]?.reason ?? "", /previous execution was still running/);

        // Once the run finishes and the execution is settled, the job is free
        // again -- the overlap rule is exactly "is an execution in flight".
        await finishRun(taskId, "succeeded");
        h.setNow(new Date("2026-08-21T03:10:00.000Z"));
        await db
          .update(scheduledJobs)
          .set({ nextRunAt: new Date("2026-08-21T03:10:00.000Z") })
          .where(eq(scheduledJobs.id, jobId));

        const third = await tick(h, jobId, "the occurrence after the run finished");
        assert.equal(third.settled.length, 1, "settling must close out the finished execution first");
        assert.equal(third.fired.length, 1, "with nothing in flight the job fires again");

        const all = await executionsOf(jobId);
        assert.equal(all.length, 3);
        assert.equal(all[0]?.status, "succeeded");
        // Every execution got its OWN task, and therefore its own volume name.
        assert.notEqual(all[2]?.taskId, all[0]?.taskId);
        await finishRun(all[2]?.taskId as string, "succeeded");
      },
    );

    it(
      "on_overlap=queue starts the occurrence anyway, and the run queue serialises it",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const jobId = await seedJob({
          cronExpr: "*/5 * * * *",
          onOverlap: "queue",
          nextRunAt: new Date("2026-08-21T03:00:00.000Z"),
        });
        const h = harness({ now: new Date("2026-08-21T03:00:00.000Z") });

        const first = await tick(h, jobId, "the first occurrence");
        assert.equal(first.fired.length, 1);

        h.setNow(new Date("2026-08-21T03:05:00.000Z"));
        await db
          .update(scheduledJobs)
          .set({ nextRunAt: new Date("2026-08-21T03:05:00.000Z") })
          .where(eq(scheduledJobs.id, jobId));

        const second = await tick(h, jobId, "the overlapping occurrence");
        assert.equal(second.fired.length, 1, "queue mode does not skip");
        assert.equal(second.skipped.length, 0);

        const executions = await executionsOf(jobId);
        assert.equal(executions.length, 2);
        assert.notEqual(executions[0]?.taskId, executions[1]?.taskId);

        for (const execution of executions) await finishRun(execution.taskId as string, "succeeded");
      },
    );

    it(
      "two workers claiming at the same instant cannot double-fire one occurrence",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const now = new Date("2026-08-21T03:00:00.000Z");
        const jobId = await seedJob({
          cronExpr: "*/5 * * * *",
          onOverlap: "queue",
          nextRunAt: new Date("2026-08-21T02:55:00.000Z"),
        });

        // Two genuinely concurrent transactions on separate connections, which
        // is what FOR UPDATE SKIP LOCKED exists to survive. Whichever gets the
        // row lock advances next_run_at inside the same transaction; the other
        // either steps over the locked row or finds it no longer due.
        const [a, b] = await withTimeout(
          Promise.all([
            claimDueJobs(db, { now, catchupGraceMs: 60_000 }),
            claimDueJobs(db, { now, catchupGraceMs: 60_000 }),
          ]),
          10_000,
          "two concurrent claims",
        );

        const mine = [...a, ...b].filter((c) => c.job.jobId === jobId);
        assert.equal(mine.length, 1, `exactly one worker may claim an occurrence, got ${mine.length}`);

        const executions = await executionsOf(jobId);
        assert.equal(executions.length, 1, "one occurrence, one execution row");
        assert.equal(executions[0]?.status, "claimed");
      },
    );

    it(
      "a disabled job is never claimed",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const jobId = await seedJob({
          enabled: false,
          nextRunAt: new Date("2026-08-21T02:00:00.000Z"),
        });
        const h = harness({ now: new Date("2026-08-21T03:00:00.000Z") });

        const result = await tick(h, jobId, "a tick with a disabled job");
        assert.equal(result.fired.length, 0);
        assert.equal((await executionsOf(jobId)).length, 0);
        // ...and its next_run_at is left exactly where it was; enabling the job
        // later should not make it look retroactively overdue by an hour.
        const job = await jobRow(jobId);
        assert.equal(job.nextRunAt.toISOString(), "2026-08-21T02:00:00.000Z");
      },
    );

    it(
      "a cron expression that can no longer produce an occurrence disables the job loudly",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        // Writing this through the API is impossible -- it is validated there --
        // but a row can be edited by hand, and a job that re-claims on every
        // tick forever is a much worse failure than one that is switched off.
        const jobId = await seedJob({
          cronExpr: "0 0 30 2 *",
          nextRunAt: new Date("2026-08-21T02:00:00.000Z"),
        });
        const h = harness({ now: new Date("2026-08-21T03:00:00.000Z") });

        await tick(h, jobId, "a tick with an impossible cron");
        const [execution] = await executionsOf(jobId);
        assert.equal(execution?.status, "failed");
        assert.match(execution?.reason ?? "", /disabled/);
        assert.equal((await jobRow(jobId)).enabled, false);
      },
    );

    it(
      "settling pushes the branch, opens the PR, and records where the work went",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const jobId = await seedJob({
          nextRunAt: new Date("2026-08-21T03:00:00.000Z"),
          autoPushBranch: true,
          autoOpenPr: true,
        });
        const h = harness({ now: new Date("2026-08-21T03:00:00.000Z") });

        const fired = await tick(h, jobId, "the fire tick");
        const taskId = fired.fired[0]?.taskId as string;
        assert.ok(taskId);

        // Nothing is published while the run is in flight: pushing rewrites
        // .git inside the volume the agent is writing to.
        await tick(h, jobId, "a tick while the run is in flight");
        assert.equal(h.publishes.length, 0);
        assert.equal((await executionsOf(jobId))[0]?.status, "running");

        await finishRun(taskId, "succeeded");
        const settledTick = await tick(h, jobId, "the settling tick");
        assert.equal(settledTick.settled.length, 1);

        assert.deepEqual(h.publishes, [{ taskId, options: { openPullRequest: true } }]);
        const [execution] = await executionsOf(jobId);
        assert.equal(execution?.status, "succeeded");
        assert.match(execution?.reason ?? "", /pushed scheduled\/x\/y \(2 file\(s\)\)/);
        assert.match(execution?.reason ?? "", /example\.invalid\/pull\/7/);
      },
    );

    it(
      "a run that made no changes settles as succeeded, not as a failure",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const jobId = await seedJob({ nextRunAt: new Date("2026-08-21T03:00:00.000Z"), autoPushBranch: true });
        const h = harness({ now: new Date("2026-08-21T03:00:00.000Z") });
        const fired = await tick(h, jobId, "the fire tick");
        const taskId = fired.fired[0]?.taskId as string;

        h.failPublishWith(new PublishError("nothing to push: the workspace is identical to the base commit"));
        await finishRun(taskId, "succeeded");
        await tick(h, jobId, "the settling tick");

        const [execution] = await executionsOf(jobId);
        assert.equal(execution?.status, "succeeded", "an audit that found nothing is not a broken schedule");
        assert.match(execution?.reason ?? "", /no changes/);
      },
    );

    it(
      "a push that fails marks the occurrence failed, because the work would die with the container",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const jobId = await seedJob({ nextRunAt: new Date("2026-08-21T03:00:00.000Z"), autoPushBranch: true });
        const h = harness({ now: new Date("2026-08-21T03:00:00.000Z") });
        const fired = await tick(h, jobId, "the fire tick");
        const taskId = fired.fired[0]?.taskId as string;

        h.failPublishWith(new PublishError("No GitHub token is configured. Add one on the Settings page."));
        await finishRun(taskId, "succeeded");
        await tick(h, jobId, "the settling tick");

        const [execution] = await executionsOf(jobId);
        assert.equal(execution?.status, "failed");
        assert.match(execution?.reason ?? "", /the push failed/);
      },
    );

    it(
      "a failed run settles as a failed occurrence, carrying the reason",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const jobId = await seedJob({ nextRunAt: new Date("2026-08-21T03:00:00.000Z"), autoPushBranch: true });
        const h = harness({ now: new Date("2026-08-21T03:00:00.000Z") });
        const fired = await tick(h, jobId, "the fire tick");

        await finishRun(fired.fired[0]?.taskId as string, "failed", "the setup script exited 1");
        await tick(h, jobId, "the settling tick");

        assert.equal(h.publishes.length, 0, "a failed run has nothing worth pushing");
        const [execution] = await executionsOf(jobId);
        assert.equal(execution?.status, "failed");
        assert.equal(execution?.reason, "the setup script exited 1");
      },
    );

    it(
      "a claim whose task was never created is written off rather than wedging the job",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const jobId = await seedJob({ nextRunAt: new Date("2026-08-21T03:00:00.000Z") });
        // `created_at` is written by Postgres, so the staleness comparison is
        // against the real clock -- the harness's injected one is deliberately
        // set a minute ahead of it rather than to a fixed fictional instant.
        const h = harness({ now: new Date(Date.now() + 60_000), staleClaimMs: 1 });

        // The worker died between the claim committing and `fireJob` running.
        // `claimed` counts as in flight, so without a timeout this job's next
        // occurrence would be skipped forever.
        await claimDueJobs(db, { now: new Date("2026-08-21T03:00:00.000Z"), catchupGraceMs: 60_000 });
        const [claimed] = await executionsOf(jobId);
        assert.equal(claimed?.status, "claimed");
        // Switched off before the settling tick so the advanced next_run_at,
        // now in the past relative to the real clock, does not fire a second
        // occurrence and confuse what is being asserted.
        await db.update(scheduledJobs).set({ enabled: false }).where(eq(scheduledJobs.id, jobId));

        await tick(h, jobId, "the settling tick");
        const [execution] = await executionsOf(jobId);
        assert.equal(execution?.status, "failed");
        assert.match(execution?.reason ?? "", /no task was ever created/);
      },
    );

    it(
      "run now fires immediately without moving the schedule, and refuses when one is in flight",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const nextRunAt = new Date("2026-08-22T03:00:00.000Z");
        const jobId = await seedJob({ cronExpr: "0 3 * * *", nextRunAt });
        const h = harness({ now: new Date("2026-08-21T14:00:00.000Z") });

        const fired = await withTimeout(h.scheduler.runNow(jobId), 10_000, "run now");
        assert.ok(fired.taskId);

        // The nightly job you poked at 14:00 is still the nightly job at 03:00.
        assert.equal((await jobRow(jobId)).nextRunAt.toISOString(), nextRunAt.toISOString());

        const [execution] = await executionsOf(jobId);
        assert.equal(execution?.status, "running");
        assert.equal(execution?.taskId, fired.taskId);

        // A second press while the first is in flight is refused with a reason
        // rather than silently recorded as a skip -- somebody is watching.
        await assert.rejects(
          () => h.scheduler.runNow(jobId),
          (error: unknown) => error instanceof RunNowError && /already has an execution in flight/.test((error as Error).message),
        );
        assert.equal((await executionsOf(jobId)).length, 1);

        // A distinct class, because "there is no such job" and "that job is
        // busy" are different things to be told: the control route answers 404
        // for one and 409 for the other.
        await assert.rejects(
          () => h.scheduler.runNow("job-that-does-not-exist"),
          (error: unknown) => error instanceof NoSuchJobError,
        );

        await finishRun(fired.taskId, "succeeded");
      },
    );

    it(
      "an occurrence that cannot resolve its base branch fails visibly instead of vanishing",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const jobId = await seedJob({ nextRunAt: new Date("2026-08-21T03:00:00.000Z") });
        const h = harness({ now: new Date("2026-08-21T03:00:00.000Z") });
        // Swap the resolver for one that fails the way a deleted branch does.
        const scheduler = new Scheduler({
          deps: {
            db,
            resolveBaseSha: () => Promise.reject(new Error("Not Found")),
            now: () => new Date("2026-08-21T03:00:00.000Z"),
          },
          tickMs: 30_000,
          claim: { catchupGraceMs: 60_000 },
        });

        const result = await withTimeout(scheduler.tick(), 10_000, "a tick with an unresolvable branch");
        assert.equal(result.fired.length, 0);
        const failed = result.failed.filter((f) => f.jobId === jobId);
        assert.equal(failed.length, 1);

        const [execution] = await executionsOf(jobId);
        assert.equal(execution?.status, "failed");
        assert.match(execution?.reason ?? "", /could not resolve/);
        // Crucially it is terminal, so the next occurrence is not blocked.
        assert.equal(await hasInFlight(jobId), false);
        void h;
      },
    );

    it("names the branch after the occurrence, not after the moment it started", () => {
      assert.equal(
        scheduledBranchName("Nightly dependency audit", new Date("2026-08-21T03:00:00.000Z")),
        "scheduled/nightly-dependency-audit/20260821T030000Z",
      );
      // Unusable ref characters are slugged away, and an empty name still
      // produces a valid ref rather than `scheduled//...`.
      assert.equal(
        scheduledBranchName("  ***  ", new Date("2026-01-02T04:05:06.000Z")),
        "scheduled/job/20260102T040506Z",
      );
    });

    async function hasInFlight(jobId: string): Promise<boolean> {
      const rows = await executionsOf(jobId);
      return rows.some((r) => r.status === "claimed" || r.status === "running");
    }
  },
);
