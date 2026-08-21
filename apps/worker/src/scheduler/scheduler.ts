import { sql } from "drizzle-orm";
import { redact } from "@codex-clone/core";
import { scheduledExecutions } from "@codex-clone/db";
import { claimDueJobs, executionId, hasActiveExecution, type ClaimOptions } from "./claim.js";
import { FireError, fireJob, failExecution, type FiredExecution } from "./execute.js";
import { settleExecutions, type SettleOptions, type SettledExecution } from "./settle.js";
import type { DueJob, SchedulerDeps } from "./types.js";

/**
 * The scheduler tick (PLAN.md §3.5).
 *
 *   every schedulerTickMs:
 *     settle()  -- occurrences whose run has finished: push, then close them out
 *     claim()   -- occurrences that have come due: fire one task each, or record
 *                  a skip with the reason
 *
 * Settle runs FIRST, and the order is load-bearing rather than tidy: an
 * execution that has finished but not yet been closed out still counts as
 * in flight, so a job with `on_overlap = skip` would record a spurious skip
 * against work that had already completed. Closing the books before deciding
 * what is due is what makes "skipped" mean what it says.
 *
 * Polling, like the run queue, and for the same reasons: a 30-second tick on an
 * indexed query costs nothing measurable, it has no reconnect semantics to get
 * wrong, and the claim is a committed row rather than a timer -- so restarting
 * the worker loses nothing at all.
 */

export interface SchedulerOptions {
  deps: SchedulerDeps;
  tickMs: number;
  claim?: ClaimOptions;
  settle?: SettleOptions;
}

export interface TickResult {
  settled: SettledExecution[];
  fired: FiredExecution[];
  skipped: Array<{ jobId: string; jobName: string; scheduledFor: Date; reason: string }>;
  failed: Array<{ jobId: string; jobName: string; reason: string }>;
}

export class RunNowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunNowError";
  }
}

/**
 * A separate class so the control route can answer 404 rather than 409.
 * "There is no such job" and "that job is busy" are different things to be
 * told, and a caller that cannot tell them apart cannot retry sensibly.
 */
export class NoSuchJobError extends RunNowError {
  constructor(jobId: string) {
    super(`no scheduled job ${jobId}`);
    this.name = "NoSuchJobError";
  }
}

export class Scheduler {
  #timer: NodeJS.Timeout | null = null;
  #stopping = false;
  #ticking = false;
  /** Resolves when a tick in progress finishes; awaited by `stop()`. */
  #inFlight: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SchedulerOptions) {}

  get running(): boolean {
    return this.#timer !== null;
  }

  start(): void {
    if (this.#timer) return;
    this.#stopping = false;
    const loop = () => {
      this.#inFlight = this.tick()
        .catch((error: unknown) => {
          // A tick that throws must never take the worker down or stop the
          // next one: the next tick re-reads the database and is unaffected by
          // whatever went wrong in this one.
          this.#log(`[scheduler] tick failed: ${redact(String(error))}`);
        })
        .finally(() => {
          if (!this.#stopping) this.#timer = setTimeout(loop, this.options.tickMs);
        });
    };
    this.#timer = setTimeout(loop, 0);
  }

  /** Stops ticking and waits, bounded, for the tick in progress. */
  async stop(graceMs = 15_000): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;

    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.#inFlight.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /**
   * One tick. Exported as a method rather than kept private because it is
   * exactly what the integration test drives -- a scheduler you can only
   * observe through a timer is a scheduler you cannot test.
   */
  async tick(): Promise<TickResult> {
    if (this.#ticking) return { settled: [], fired: [], skipped: [], failed: [] };
    this.#ticking = true;
    try {
      const settled = await settleExecutions(this.options.deps, this.options.settle ?? {}).catch(
        (error: unknown) => {
          this.#log(`[scheduler] settling failed: ${redact(String(error))}`);
          return [] as SettledExecution[];
        },
      );

      const now = this.options.deps.now?.();
      const claims = await claimDueJobs(this.options.deps.db, {
        ...this.options.claim,
        ...(now ? { now } : {}),
        log: (message) => this.#log(message),
      });

      const result: TickResult = { settled, fired: [], skipped: [], failed: [] };
      for (const claim of claims) {
        if (claim.kind === "skip") {
          this.#log(`[scheduler] job "${claim.job.name}" skipped an occurrence: ${claim.reason}`);
          result.skipped.push({
            jobId: claim.job.jobId,
            jobName: claim.job.name,
            scheduledFor: claim.job.scheduledFor,
            reason: claim.reason,
          });
          continue;
        }
        const fired = await this.#fire(claim.job);
        if (fired.ok) result.fired.push(fired.execution);
        else result.failed.push({ jobId: claim.job.jobId, jobName: claim.job.name, reason: fired.reason });
      }
      return result;
    } finally {
      this.#ticking = false;
    }
  }

  /**
   * "Run now" from the UI.
   *
   * Deliberately the same fire path, and deliberately NOT a schedule change:
   * running a job by hand does not move `next_run_at`, because the nightly job
   * you poked at 14:00 should still be the nightly job at 03:00.
   *
   * It refuses rather than recording a skip when something is already in
   * flight. A skip is the right answer for an occurrence nobody asked for; a
   * person who just pressed a button deserves to be told why nothing happened.
   */
  async runNow(jobId: string): Promise<FiredExecution> {
    const deps = this.options.deps;
    const now = deps.now?.() ?? new Date();

    const [row] = await deps.db.execute<{
      id: string;
      job_name: string;
      prompt: string;
      base_branch: string;
      cron_expr: string;
      timezone: string;
      on_overlap: "skip" | "queue";
      catchup: boolean;
      auto_push_branch: boolean;
      auto_open_pr: boolean;
      repo_id: string;
      owner: string;
      repo_name: string;
      full_name: string;
    }>(sql`
      select j.id, j.name as job_name, j.prompt, j.base_branch, j.cron_expr, j.timezone,
             j.on_overlap, j.catchup, j.auto_push_branch, j.auto_open_pr,
             r.id as repo_id, r.owner, r.name as repo_name, r.full_name
      from scheduled_jobs j
      join repos r on r.id = j.repo_id
      where j.id = ${jobId}
      limit 1
    `);
    if (!row) throw new NoSuchJobError(jobId);

    if (await hasActiveExecution(deps.db, jobId)) {
      throw new RunNowError("this job already has an execution in flight; wait for it to finish");
    }

    const job: DueJob = {
      jobId: row.id,
      name: row.job_name,
      repo: { id: row.repo_id, owner: row.owner, name: row.repo_name, fullName: row.full_name },
      prompt: row.prompt,
      baseBranch: row.base_branch,
      cronExpr: row.cron_expr,
      timezone: row.timezone,
      onOverlap: row.on_overlap,
      catchup: row.catchup,
      autoPushBranch: row.auto_push_branch,
      autoOpenPr: row.auto_open_pr,
      scheduledFor: now,
      executionId: executionId(),
    };

    await deps.db.insert(scheduledExecutions).values({
      id: job.executionId,
      jobId: job.jobId,
      scheduledFor: now,
      status: "claimed",
      reason: "started by hand",
    });

    const fired = await this.#fire(job);
    if (!fired.ok) throw new RunNowError(fired.reason);
    return fired.execution;
  }

  /**
   * Fires a claimed occurrence, recording the failure on the execution row when
   * it cannot.
   *
   * Nothing here is allowed to throw past this point: the claim is already
   * committed, so an exception that escaped would leave the execution in
   * `claimed` and -- because `claimed` counts as in flight -- would wedge the
   * job's next occurrence behind it until the stale-claim timeout.
   */
  async #fire(job: DueJob): Promise<{ ok: true; execution: FiredExecution } | { ok: false; reason: string }> {
    try {
      return { ok: true, execution: await fireJob(this.options.deps, job) };
    } catch (error) {
      const reason =
        error instanceof FireError
          ? error.message
          : `could not start this occurrence: ${redact(error instanceof Error ? error.message : String(error))}`;
      this.#log(`[scheduler] job "${job.name}" could not fire: ${reason}`);
      await failExecution(this.options.deps, job.executionId, reason).catch((err: unknown) => {
        this.#log(`[scheduler] could not record the failure: ${redact(String(err))}`);
      });
      return { ok: false, reason };
    }
  }

  #log(message: string): void {
    this.options.deps.log?.(message);
  }
}
