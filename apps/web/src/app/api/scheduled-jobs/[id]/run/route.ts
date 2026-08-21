import { NextResponse } from "next/server";

/**
 * `POST /api/scheduled-jobs/:id/run` — "Run now".
 *
 * A proxy, deliberately, exactly like the publish route. Firing an occurrence
 * means writing an execution row, resolving the base branch to a fresh SHA and
 * creating a task -- and the worker already does all of that on every tick. A
 * second implementation here would be a second thing to keep in step with the
 * first, and the difference would only ever show up in the one path nobody
 * watches.
 *
 * The forward happens server-side, which is what makes the worker's control API
 * safe to leave unauthenticated on loopback: it answers no CORS headers, so the
 * JSON content-type it insists on means a page on another site cannot reach it
 * from the user's browser.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Resolving a ref against GitHub is the slow part; a task insert is not. */
const RUN_TIMEOUT_MS = 60_000;

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const controlUrl = workerControlUrl();

  try {
    const response = await fetch(`${controlUrl}/control/schedule/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: id }),
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    // A worker that is not running is the single most likely cause, and it is
    // something the reader can act on -- unlike "fetch failed". It is also the
    // honest answer here: with no worker there is no scheduler at all, so the
    // job would not have fired on its own either.
    return NextResponse.json(
      {
        error: `Could not reach the worker at ${controlUrl}. Is \`pnpm dev\` running? (${message(error)})`,
      },
      { status: 502 },
    );
  }
}

/**
 * The worker's control API shares the WebSocket port. `NEXT_PUBLIC_WS_URL` is
 * the one place that address is configured, so it is reused here rather than
 * introducing a second variable that can drift out of step with it.
 */
function workerControlUrl(): string {
  const ws = process.env["NEXT_PUBLIC_WS_URL"] ?? "ws://127.0.0.1:8787";
  return ws.replace(/^ws/, "http").replace(/\/$/, "");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
