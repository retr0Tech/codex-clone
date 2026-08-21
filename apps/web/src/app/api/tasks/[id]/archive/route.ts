import { NextResponse } from "next/server";

import { callWorker } from "../../../_lib/worker-control";

/**
 *   POST   /api/tasks/:id/archive  -> archive: cold snapshot, drop the volume
 *   DELETE /api/tasks/:id/archive  -> restore: back to the sidebar
 *
 * Archiving is a status change, not a deletion (PLAN.md §3.10). The event log
 * is retained in full and the cold snapshot is kept, which is why this cannot
 * be a `DELETE /api/tasks/:id` -- there is nothing here that deletes anything.
 *
 * Both forward to the worker, because archiving has to export the workspace
 * volume before it drops it and only the worker can reach one. A 409 comes back
 * when the task has a run in flight: archiving a workspace out from under a
 * live container would leave the agent writing into something the UI says is
 * gone.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { status, body } = await callWorker("/control/archive", { taskId: id });
  return NextResponse.json(body, { status });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { status, body } = await callWorker("/control/unarchive", { taskId: id });
  return NextResponse.json(body, { status });
}
