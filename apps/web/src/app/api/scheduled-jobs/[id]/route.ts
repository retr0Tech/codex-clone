import { NextResponse } from "next/server";

import { db } from "../../_lib/settings-store";
import { UnknownJobError, deleteScheduledJob, getScheduledJob, updateScheduledJob } from "../_lib/jobs";
import { InvalidScheduledJobError, parseUpdateScheduledJob } from "../_lib/parse";

/**
 * One scheduled job.
 *
 *   GET    /api/scheduled-jobs/:id  -> the job and its recent occurrences
 *   PATCH  /api/scheduled-jobs/:id  -> edit anything, including `enabled`
 *   DELETE /api/scheduled-jobs/:id  -> remove the schedule (not its tasks)
 *
 * The enable/disable toggle is a PATCH rather than an endpoint of its own
 * because it is the same write, with the same `next_run_at` recomputation
 * behind it: a job switched back on must not immediately fire the occurrence it
 * missed while it was paused.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const job = await getScheduledJob(db(), id);
    if (!job) return NextResponse.json({ error: `no scheduled job ${id}` }, { status: 404 });
    return NextResponse.json({ job });
  } catch (error) {
    return NextResponse.json({ error: message(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "the request body must be valid JSON" }, { status: 400 });
  }

  try {
    const current = await getScheduledJob(db(), id);
    if (!current) return NextResponse.json({ error: `no scheduled job ${id}` }, { status: 404 });

    // The current schedule is passed in so a patch that changes only the
    // timezone is still validated against the expression it will run with.
    const patch = parseUpdateScheduledJob(body, { cronExpr: current.cronExpr, timezone: current.timezone });
    const job = await updateScheduledJob(db(), id, patch);
    return NextResponse.json({ job });
  } catch (error) {
    if (error instanceof InvalidScheduledJobError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof UnknownJobError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: message(error) }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    await deleteScheduledJob(db(), id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof UnknownJobError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: message(error) }, { status: 500 });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
