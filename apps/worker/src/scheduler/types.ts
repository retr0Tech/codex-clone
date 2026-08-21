import type { Database } from "@codex-clone/db";
import type { PublishOptions, PublishResult } from "../runner/publish.js";

/**
 * The scheduler's shared vocabulary (PLAN.md §3.5).
 *
 * Two ideas carry the whole subsystem and are worth naming before any code:
 *
 * **An occurrence is a row, always.** Firing writes one, and so does deciding
 * not to fire -- a schedule that silently did nothing is indistinguishable from
 * one that is broken, so "skipped, because the previous execution was still
 * running" is recorded with the same weight as a run.
 *
 * **The execution's status is the claim.** `claimed` and `running` mean this
 * occurrence is still in flight, and the overlap rule is nothing more than
 * asking whether the job has one of those. That is why `settle()` matters: it
 * is what turns an in-flight execution terminal, and therefore what lets the
 * next occurrence fire.
 */

export type ExecutionStatus = "claimed" | "running" | "succeeded" | "failed" | "skipped";

export interface JobRepo {
  id: string;
  owner: string;
  name: string;
  fullName: string;
}

/** A scheduled job whose `next_run_at` has come due, as the claim found it. */
export interface DueJob {
  jobId: string;
  name: string;
  repo: JobRepo;
  prompt: string;
  baseBranch: string;
  cronExpr: string;
  timezone: string;
  onOverlap: "skip" | "queue";
  catchup: boolean;
  autoPushBranch: boolean;
  autoOpenPr: boolean;
  /** The occurrence this claim covers: the `next_run_at` that was due. */
  scheduledFor: Date;
  /** The row written for it, already committed. */
  executionId: string;
}

/** What the claim decided, per due job. */
export type Claim =
  | { kind: "fire"; job: DueJob }
  | { kind: "skip"; job: DueJob; reason: string };

export interface SchedulerDeps {
  db: Database;
  /**
   * Branch -> SHA, at fire time.
   *
   * Injected rather than imported: the integration test points it at a bare
   * repository on local disk, which exercises the identical path without a
   * network or a token. In the worker it is the GitHub client.
   */
  resolveBaseSha: (repo: JobRepo, branch: string) => Promise<string>;
  /**
   * The milestone 7 publish path, unchanged.
   *
   * There is deliberately no second implementation of commit-push-PR here: an
   * unattended run's output has exactly the same problem a manual one's does,
   * and it is already solved. Absent means "auto-push is unavailable", which is
   * recorded on the execution rather than silently ignored.
   */
  publish?: (taskId: string, options: PublishOptions) => Promise<PublishResult>;
  /** Injectable clock. Every due/late decision reads it, so tests can move it. */
  now?: () => Date;
  log?: (message: string) => void;
}
