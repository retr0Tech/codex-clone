import type { RunStatus } from "@codex-clone/core";

/**
 * What `/api/scheduled-jobs` returns, in one place both sides can see.
 *
 * Free of any `server-only` import and of `Date`, for the same reason
 * `lib/types.ts` is: the route handlers build these and client components
 * render them, so the shape has to survive JSON and has to be describable in a
 * file the browser bundle is allowed to touch.
 */

export type OnOverlap = "skip" | "queue";
export type ScheduledExecutionStatus = "claimed" | "running" | "succeeded" | "failed" | "skipped";

export interface ScheduledExecutionView {
  id: string;
  /** Null for a skipped occurrence: no workspace was ever created for it. */
  taskId: string | null;
  /** The occurrence this row is for, not the moment the container started. */
  scheduledFor: string;
  status: ScheduledExecutionStatus;
  /** Why it was skipped, where the branch went, or how it failed. */
  reason: string | null;
  /** The run's own status, when there is a run. */
  runStatus: RunStatus | null;
  createdAt: string;
}

export interface ScheduledJobView {
  id: string;
  name: string;
  repoFullName: string;
  prompt: string;
  baseBranch: string;
  cronExpr: string;
  /** A plain-English gloss, or null when the expression is its own best label. */
  cronHuman: string | null;
  timezone: string;
  enabled: boolean;
  onOverlap: OnOverlap;
  catchup: boolean;
  autoPushBranch: boolean;
  autoOpenPr: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  createdAt: string;
  /** Most recent first, including the ones that were deliberately skipped. */
  recent: ScheduledExecutionView[];
}
