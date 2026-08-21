import { NextResponse } from "next/server";

import { db } from "../_lib/settings-store";
import { UnknownRepoError, createScheduledJob, listScheduledJobs } from "./_lib/jobs";
import { InvalidScheduledJobError, parseCreateScheduledJob } from "./_lib/parse";

/**
 * Scheduled jobs.
 *
 *   GET  /api/scheduled-jobs   -> every job, with its recent occurrences
 *   POST /api/scheduled-jobs   -> create one
 *
 * The POST writes one row and computes its first `next_run_at`; it does not
 * start anything. The worker's tick claims the job out of Postgres when it
 * comes due, which is why the web app can stay a stock App Router process with
 * no timers and no background work of its own.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ jobs: await listScheduledJobs(db()) });
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
    const input = parseCreateScheduledJob(body);
    const job = await createScheduledJob(db(), input);
    console.log(
      `[scheduled-jobs] created ${job.id} "${job.name}" on ${job.repoFullName}@${job.baseBranch}` +
        ` (${job.cronExpr} ${job.timezone}), first run ${job.nextRunAt}`,
    );
    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    if (error instanceof InvalidScheduledJobError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof UnknownRepoError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: message(error) }, { status: 500 });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
