import { NextResponse } from "next/server";

import { callWorker } from "../../../_lib/worker-control";

/**
 * `POST /api/tasks/:id/rebase` — replay the work branch onto the latest base.
 *
 * The explicit half of PLAN.md §3.10. Restoring an archived task recreates the
 * workspace **as it was**; it never rebases on its own, because silently
 * replaying somebody's work onto a commit they have not seen is the kind of
 * helpfulness that loses work. This route is the button that says otherwise.
 *
 * It also moves `tasks.base_sha`, which is why it has to be a deliberate
 * action: every diff in the system is derived against that pin.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { status, body } = await callWorker("/control/rebase", { taskId: id });
  return NextResponse.json(body, { status });
}
