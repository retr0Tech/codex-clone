import { NextResponse } from "next/server";

import { db } from "../../_lib/settings-store";
import { InvalidTaskError, getTask, listRuns, queueFollowUp } from "../../_lib/tasks";

/**
 *   GET  /api/tasks/:id   -> the task, its repo, and every run it has had
 *   POST /api/tasks/:id   -> queue a follow-up turn against the warm workspace
 *
 * A follow-up is a new run rather than a mutation of the last one, so the
 * transcript stays append-only and the queue's one-run-per-task rule keeps two
 * turns from racing into the same workspace volume.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const database = db();
    const task = await getTask(database, id);
    if (!task) return NextResponse.json({ error: "no such task" }, { status: 404 });

    return NextResponse.json({ task, runs: await listRuns(database, id) });
  } catch (error) {
    return NextResponse.json({ error: message(error) }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "the request body must be valid JSON" }, { status: 400 });
  }

  const prompt = (body as { prompt?: unknown } | null)?.prompt;
  if (typeof prompt !== "string") {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  try {
    const queued = await queueFollowUp(db(), id, prompt);
    return NextResponse.json({ taskId: id, ...queued }, { status: 201 });
  } catch (error) {
    if (error instanceof InvalidTaskError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: message(error) }, { status: 500 });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
