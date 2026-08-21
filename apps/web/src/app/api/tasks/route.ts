import { NextResponse } from "next/server";

import { MissingGithubTokenError } from "../_lib/github";
import { db } from "../_lib/settings-store";
import { InvalidTaskError, UnknownRepoError, createTask, listTasks, parseCreateTask } from "../_lib/tasks";

/**
 * Tasks.
 *
 *   GET  /api/tasks              -> the task list for the sidebar
 *   POST /api/tasks              -> create a task and queue its first run
 *
 * The POST does no work of its own beyond writing two rows: it resolves the
 * branch to a SHA and queues. The worker picks the run up through the
 * `FOR UPDATE SKIP LOCKED` claim, which is why the web app can stay a stock
 * App Router process with no background jobs and no custom server.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const includeArchived = new URL(request.url).searchParams.get("archived") === "1";
  try {
    return NextResponse.json({ tasks: await listTasks(db(), includeArchived) });
  } catch (error) {
    return NextResponse.json({ error: message(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "the request body must be valid JSON" }, { status: 400 });
  }

  try {
    const input = parseCreateTask(body);
    const created = await createTask(db(), input);
    console.log(`[tasks] queued ${created.taskId} on ${created.repoFullName}@${created.baseSha.slice(0, 8)}`);
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof InvalidTaskError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof UnknownRepoError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof MissingGithubTokenError) {
      return NextResponse.json({ error: error.message }, { status: 412 });
    }
    // A branch that does not exist comes back from Octokit as a 404; say so in
    // the terms the user typed rather than echoing an API error.
    if (isNotFound(error)) {
      return NextResponse.json({ error: "that branch does not exist on this repository" }, { status: 404 });
    }
    return NextResponse.json({ error: message(error) }, { status: 502 });
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: number }).status === 404;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
