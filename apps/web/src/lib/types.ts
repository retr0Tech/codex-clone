import type { BudgetBreach, RunPhase, RunStatus } from "@codex-clone/core";

/**
 * What the REST layer returns, in one place both sides can see.
 *
 * Deliberately free of any `server-only` import: the route handlers build these
 * and the client components render them, so the shape has to be describable in
 * a file a browser bundle is allowed to touch. Dates are ISO strings for the
 * same reason -- that is what survives JSON.
 */

export type TaskMode = "ask" | "code";
export type TaskStatus = "idle" | "queued" | "running" | "archived";

export interface RunView {
  id: string;
  prompt: string;
  status: RunStatus;
  phase: RunPhase;
  stopReason: string | null;
  /**
   * Which bound stopped this run, or null. Null for a cancelled run: the
   * distinction between "you stopped it" and "it ran out of budget" is carried
   * as data rather than inferred from the numbers, because inferring it is how
   * a cancelled run came to be reported as a budget breach.
   */
  budgetBreach: BudgetBreach | null;
  turns: number;
  /** Total prompt tokens. `cachedInputTokens` is a SUBSET of this, not an addition. */
  inputTokens: number;
  /** Served from the prompt cache, billed at roughly a tenth of the input rate. */
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface TaskView {
  id: string;
  title: string;
  mode: TaskMode;
  status: TaskStatus;
  repoFullName: string;
  baseBranch: string;
  baseSha: string;
  workBranch: string | null;
  /** Null until the worker has seeded the hot volume for this task. */
  volumeName: string | null;
  /** Archive is a status change, not a deletion (PLAN.md §3.10). */
  archivedAt: string | null;
  lastActivityAt: string;
  createdAt: string;
  latestRun: RunView | null;
}

export interface RepoView {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  setupScript: string | null;
}

export interface BranchView {
  name: string;
  sha: string;
  protected: boolean;
}
