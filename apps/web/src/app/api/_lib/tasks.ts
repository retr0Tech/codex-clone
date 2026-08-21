import "server-only";

import { randomUUID } from "node:crypto";
import { asc, desc, eq, ne } from "drizzle-orm";
import { repos, runs, tasks, type Database } from "@codex-clone/db";
import { findRepoByFullName, persistRepos } from "@codex-clone/github";

import { githubClient } from "./github";

/**
 * Task creation, shared by the REST route and (later) the scheduler.
 *
 * Two rules the route must not be able to bend:
 *
 *  1. **The base SHA is resolved here, from the branch name.** A client-supplied
 *     SHA is never trusted -- every diff in the system is derived against
 *     `tasks.base_sha`, so accepting one from the browser would let the caller
 *     choose what "changed" means.
 *
 *  2. **A task is created together with its first run, in one transaction.** A
 *     task with no run is a workspace nobody asked for; a run with no task is
 *     unclaimable. Neither half is a state the worker should ever have to
 *     handle.
 */

export type TaskMode = "ask" | "code";

export interface CreateTaskInput {
  repoFullName: string;
  baseBranch: string;
  prompt: string;
  mode?: TaskMode;
  title?: string;
}

export interface CreatedTask {
  taskId: string;
  runId: string;
  baseSha: string;
  repoFullName: string;
  baseBranch: string;
}

export class InvalidTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTaskError";
  }
}

export class UnknownRepoError extends Error {
  constructor(fullName: string) {
    super(`No repository named "${fullName}" is available. Refresh the repository list on the home page.`);
    this.name = "UnknownRepoError";
  }
}

/** `owner/name`, the only shape the rest of the system addresses a repo by. */
const FULL_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** Deliberately permissive: git refs allow a lot, but not these. */
const BAD_REF = /(^-|\.\.|[\s~^:?*[\\]|@\{|\/$|^\/)/;

export const MAX_PROMPT_BYTES = 32 * 1024;

export function parseCreateTask(body: unknown): CreateTaskInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidTaskError("the request body must be a JSON object");
  }
  const o = body as Record<string, unknown>;

  const repoFullName = str(o["repoFullName"], "repoFullName");
  if (!FULL_NAME.test(repoFullName)) {
    throw new InvalidTaskError(`repoFullName must look like "owner/name", got "${repoFullName}"`);
  }

  const baseBranch = str(o["baseBranch"], "baseBranch");
  if (BAD_REF.test(baseBranch)) throw new InvalidTaskError(`"${baseBranch}" is not a usable branch name`);

  const prompt = str(o["prompt"], "prompt");
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new InvalidTaskError(`prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
  }

  const mode = o["mode"] === undefined ? "code" : o["mode"];
  if (mode !== "ask" && mode !== "code") throw new InvalidTaskError(`mode must be "ask" or "code"`);

  const title = typeof o["title"] === "string" && o["title"].trim() !== "" ? o["title"].trim() : titleFrom(prompt);

  return { repoFullName, baseBranch, prompt, mode, title };
}

function str(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidTaskError(`${name} is required`);
  }
  return value.trim();
}

/** First line of the prompt, trimmed to something that fits in a sidebar row. */
export function titleFrom(prompt: string): string {
  const line = prompt.split("\n").find((l) => l.trim() !== "")?.trim() ?? "Untitled task";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

export async function createTask(db: Database, input: CreateTaskInput): Promise<CreatedTask> {
  const repo = await resolveRepo(db, input.repoFullName);

  // Resolved server-side, from the branch the user picked. This is the pin
  // every future diff is measured against.
  const client = await githubClient();
  const baseSha = await client.resolveRefSha(repo.owner, repo.name, input.baseBranch);

  const taskId = `task_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

  await db.transaction(async (tx) => {
    await tx.insert(tasks).values({
      id: taskId,
      repoId: repo.id,
      title: input.title ?? titleFrom(input.prompt),
      mode: input.mode ?? "code",
      baseBranch: input.baseBranch,
      baseSha,
      // volume_name stays null until the worker has actually seeded it; it
      // doubles as the "this workspace exists" marker.
      status: "queued",
    });
    await tx.insert(runs).values({ id: runId, taskId, prompt: input.prompt, status: "queued" });
  });

  return { taskId, runId, baseSha, repoFullName: repo.fullName, baseBranch: input.baseBranch };
}

/**
 * Queues a follow-up turn against an existing task.
 *
 * A follow-up is a new run, not a continuation of the old one: the transcript
 * stays append-only, the workspace volume is reused warm, and the queue's
 * "one running run per task" rule serialises them.
 */
export async function queueFollowUp(db: Database, taskId: string, prompt: string): Promise<{ runId: string }> {
  if (prompt.trim() === "") throw new InvalidTaskError("prompt is required");
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new InvalidTaskError(`prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
  }

  const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await db.transaction(async (tx) => {
    const [task] = await tx.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task) throw new InvalidTaskError(`no task ${taskId}`);
    if (task.status === "archived") throw new InvalidTaskError("this task is archived");

    await tx.insert(runs).values({ id: runId, taskId, prompt: prompt.trim(), status: "queued" });
    await tx.update(tasks).set({ status: "queued", lastActivityAt: new Date() }).where(eq(tasks.id, taskId));
  });
  return { runId };
}

/**
 * The repo row, refreshing from GitHub once if we have never seen this name.
 *
 * `tasks.repo_id` is a foreign key, so the row has to exist before the task
 * does; a user who types a repo name we have not listed yet should get a task,
 * not a foreign-key error.
 */
async function resolveRepo(db: Database, fullName: string) {
  const existing = await findRepoByFullName(db, fullName);
  if (existing) return existing;

  const [owner, name] = fullName.split("/") as [string, string];
  const client = await githubClient();
  const summary = await client.getRepository(owner, name).catch(() => null);
  if (!summary) throw new UnknownRepoError(fullName);

  await persistRepos(db, [summary]);
  const persisted = await findRepoByFullName(db, fullName);
  if (!persisted) throw new UnknownRepoError(fullName);
  return persisted;
}

export interface TaskSummary {
  id: string;
  title: string;
  mode: TaskMode;
  status: "idle" | "queued" | "running" | "archived";
  repoFullName: string;
  baseBranch: string;
  baseSha: string;
  workBranch: string | null;
  lastActivityAt: string;
  createdAt: string;
  latestRun: {
    id: string;
    status: string;
    phase: string;
    stopReason: string | null;
    turns: number;
    costUsd: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  } | null;
}

export async function listTasks(db: Database, includeArchived = false): Promise<TaskSummary[]> {
  const rows = await db
    .select({ task: tasks, repo: repos })
    .from(tasks)
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .where(includeArchived ? undefined : ne(tasks.status, "archived"))
    .orderBy(desc(tasks.lastActivityAt));

  return Promise.all(rows.map((row) => withLatestRun(db, row.task, row.repo)));
}

export async function getTask(db: Database, taskId: string): Promise<TaskSummary | null> {
  const [row] = await db
    .select({ task: tasks, repo: repos })
    .from(tasks)
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .where(eq(tasks.id, taskId))
    .limit(1);
  return row ? withLatestRun(db, row.task, row.repo) : null;
}

/** Every run of a task, oldest first -- the order the transcript replays in. */
export async function listRuns(db: Database, taskId: string) {
  return db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.createdAt));
}

async function withLatestRun(
  db: Database,
  task: typeof tasks.$inferSelect,
  repo: typeof repos.$inferSelect,
): Promise<TaskSummary> {
  const [run] = await db
    .select()
    .from(runs)
    .where(eq(runs.taskId, task.id))
    .orderBy(desc(runs.createdAt))
    .limit(1);

  return {
    id: task.id,
    title: task.title,
    mode: task.mode,
    status: task.status,
    repoFullName: repo.fullName,
    baseBranch: task.baseBranch,
    baseSha: task.baseSha,
    workBranch: task.workBranch,
    lastActivityAt: task.lastActivityAt.toISOString(),
    createdAt: task.createdAt.toISOString(),
    latestRun: run
      ? {
          id: run.id,
          status: run.status,
          phase: run.phase,
          stopReason: run.stopReason,
          turns: run.turns,
          costUsd: run.costUsd,
          inputTokens: run.inputTokens,
          cachedInputTokens: run.cachedInputTokens,
          outputTokens: run.outputTokens,
        }
      : null,
  };
}
