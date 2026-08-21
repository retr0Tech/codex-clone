import "server-only";

import { randomUUID } from "node:crypto";
import { desc, eq, inArray } from "drizzle-orm";
import { describeCron, nextCronRun } from "@codex-clone/cron";
import { repos, runs, scheduledExecutions, scheduledJobs, type Database } from "@codex-clone/db";
import { findRepoByFullName } from "@codex-clone/github";

import type { ScheduledExecutionView, ScheduledJobView } from "../../../../lib/scheduled";
import type { CreateScheduledJobInput, UpdateScheduledJobInput } from "./parse";

/**
 * Scheduled-job persistence.
 *
 * The web app owns creating, editing and deleting jobs -- they are ordinary
 * rows, and nothing about them needs a Docker volume. It owns exactly none of
 * the firing: "Run now" is proxied to the worker so that a manual run takes the
 * identical path a scheduled one does. Two ways to start an execution is two
 * ways for them to differ.
 *
 * The one piece of arithmetic that lives on BOTH sides is `next_run_at`, and
 * that is why the cron parser is a shared package: the web app computes the
 * first occurrence when a job is created or its schedule is edited, and the
 * worker computes every one after that. Same library, same answer.
 */

export class UnknownRepoError extends Error {
  constructor(fullName: string) {
    super(`No repository named "${fullName}" is available. Refresh the repository list on the home page.`);
    this.name = "UnknownRepoError";
  }
}

export class UnknownJobError extends Error {
  constructor(id: string) {
    super(`No scheduled job ${id}`);
    this.name = "UnknownJobError";
  }
}

/** How many occurrences a job card shows. Enough to see a pattern of skips. */
export const RECENT_EXECUTIONS = 8;

export async function listScheduledJobs(db: Database): Promise<ScheduledJobView[]> {
  const rows = await db
    .select({ job: scheduledJobs, repo: repos })
    .from(scheduledJobs)
    .innerJoin(repos, eq(repos.id, scheduledJobs.repoId))
    .orderBy(desc(scheduledJobs.createdAt));
  if (rows.length === 0) return [];

  const history = await recentExecutions(
    db,
    rows.map((r) => r.job.id),
  );
  return rows.map((row) => toJobView(row.job, row.repo, history.get(row.job.id) ?? []));
}

export async function getScheduledJob(db: Database, id: string): Promise<ScheduledJobView | null> {
  const [row] = await db
    .select({ job: scheduledJobs, repo: repos })
    .from(scheduledJobs)
    .innerJoin(repos, eq(repos.id, scheduledJobs.repoId))
    .where(eq(scheduledJobs.id, id))
    .limit(1);
  if (!row) return null;
  const history = await recentExecutions(db, [id]);
  return toJobView(row.job, row.repo, history.get(id) ?? []);
}

export async function createScheduledJob(db: Database, input: CreateScheduledJobInput): Promise<ScheduledJobView> {
  const repo = await findRepoByFullName(db, input.repoFullName);
  if (!repo) throw new UnknownRepoError(input.repoFullName);

  const id = `job_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await db.insert(scheduledJobs).values({
    id,
    name: input.name,
    repoId: repo.id,
    prompt: input.prompt,
    baseBranch: input.baseBranch,
    cronExpr: input.cronExpr,
    timezone: input.timezone,
    enabled: input.enabled,
    onOverlap: input.onOverlap,
    catchup: input.catchup,
    autoPushBranch: input.autoPushBranch,
    autoOpenPr: input.autoOpenPr,
    nextRunAt: input.nextRunAt,
  });

  const created = await getScheduledJob(db, id);
  if (!created) throw new UnknownJobError(id);
  return created;
}

/**
 * Applies a patch, recomputing `next_run_at` when it could otherwise be wrong.
 *
 * Two cases need it, and both are easy to miss:
 *
 *  - the **schedule changed**, so the stored occurrence belongs to the old one;
 *  - the job is being **re-enabled** after sitting paused. Its `next_run_at` is
 *    whatever it was when it was switched off, which is now in the past -- so
 *    without this, switching a job back on fires it immediately, which is not
 *    what anyone means by "resume".
 */
export async function updateScheduledJob(
  db: Database,
  id: string,
  patch: UpdateScheduledJobInput,
): Promise<ScheduledJobView> {
  const [current] = await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)).limit(1);
  if (!current) throw new UnknownJobError(id);

  const now = new Date();
  const cronExpr = patch.cronExpr ?? current.cronExpr;
  const timezone = patch.timezone ?? current.timezone;
  const scheduleChanged = cronExpr !== current.cronExpr || timezone !== current.timezone;
  const beingEnabled = patch.enabled === true && !current.enabled;

  const nextRunAt =
    scheduleChanged || (beingEnabled && current.nextRunAt <= now)
      ? { nextRunAt: nextCronRun(cronExpr, timezone, now) }
      : {};

  await db
    .update(scheduledJobs)
    .set({ ...patch, ...nextRunAt })
    .where(eq(scheduledJobs.id, id));

  const updated = await getScheduledJob(db, id);
  if (!updated) throw new UnknownJobError(id);
  return updated;
}

/**
 * Deletes the job and its execution history.
 *
 * The TASKS those executions produced are deliberately left alone: they are
 * ordinary tasks with real transcripts, real diffs and possibly a pushed
 * branch, and deleting the schedule that started them is not a statement about
 * the work. `scheduled_executions.task_id` is `ON DELETE SET NULL` for the
 * mirror-image reason.
 */
export async function deleteScheduledJob(db: Database, id: string): Promise<void> {
  const deleted = await db.delete(scheduledJobs).where(eq(scheduledJobs.id, id)).returning({ id: scheduledJobs.id });
  if (deleted.length === 0) throw new UnknownJobError(id);
}

/**
 * The last few occurrences per job, newest first, INCLUDING skips.
 *
 * One query for every job on the page rather than one per job: the list is
 * server-rendered on first paint, and N+1 there is N+1 in the critical path.
 */
async function recentExecutions(
  db: Database,
  jobIds: string[],
): Promise<Map<string, ScheduledExecutionView[]>> {
  const rows = await db
    .select({ execution: scheduledExecutions, runStatus: runs.status })
    .from(scheduledExecutions)
    .leftJoin(runs, eq(runs.scheduledExecutionId, scheduledExecutions.id))
    .where(inArray(scheduledExecutions.jobId, jobIds))
    .orderBy(desc(scheduledExecutions.scheduledFor), desc(scheduledExecutions.createdAt));

  const byJob = new Map<string, ScheduledExecutionView[]>();
  for (const row of rows) {
    const list = byJob.get(row.execution.jobId) ?? [];
    if (list.length >= RECENT_EXECUTIONS) continue;
    list.push({
      id: row.execution.id,
      taskId: row.execution.taskId,
      scheduledFor: row.execution.scheduledFor.toISOString(),
      status: row.execution.status,
      reason: row.execution.reason,
      runStatus: row.runStatus ?? null,
      createdAt: row.execution.createdAt.toISOString(),
    });
    byJob.set(row.execution.jobId, list);
  }
  return byJob;
}

function toJobView(
  job: typeof scheduledJobs.$inferSelect,
  repo: typeof repos.$inferSelect,
  recent: ScheduledExecutionView[],
): ScheduledJobView {
  return {
    id: job.id,
    name: job.name,
    repoFullName: repo.fullName,
    prompt: job.prompt,
    baseBranch: job.baseBranch,
    cronExpr: job.cronExpr,
    cronHuman: describeCron(job.cronExpr),
    timezone: job.timezone,
    enabled: job.enabled,
    onOverlap: job.onOverlap,
    catchup: job.catchup,
    autoPushBranch: job.autoPushBranch,
    autoOpenPr: job.autoOpenPr,
    nextRunAt: job.nextRunAt.toISOString(),
    lastRunAt: job.lastRunAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    recent,
  };
}
