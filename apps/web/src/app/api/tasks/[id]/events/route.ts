import { NextResponse } from "next/server";

import { readEvents } from "@codex-clone/db";

import { db } from "../../../_lib/settings-store";

/**
 * `GET /api/tasks/:id/events?after=N` -> `AnyEventRow[]`.
 *
 * The other half of PLAN.md §3.6. This returns the SAME `{seq, type, payload}`
 * rows the WebSocket hub sends live -- literally the same function builds them,
 * in @codex-clone/db -- so the client folds both through one reducer and a
 * reload cannot render something the live view could not.
 *
 * `after` is the same cursor the socket handshake carries, which is what makes
 * "reload the page" and "reconnect the socket" the same operation with the same
 * argument.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const raw = new URL(request.url).searchParams.get("after");
  const after = Number(raw ?? 0);
  if (!Number.isFinite(after) || after < 0) {
    return NextResponse.json({ error: "after must be a non-negative number" }, { status: 400 });
  }

  try {
    // Deliberately a bare array, not { events: [...] }: the type is
    // `AnyEventRow[]` exactly, so a caller can hand the response straight to
    // the reducer without unwrapping a shape that only exists over HTTP.
    return NextResponse.json(await readEvents(db(), id, after));
  } catch (error) {
    return NextResponse.json({ error: message(error) }, { status: 500 });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
