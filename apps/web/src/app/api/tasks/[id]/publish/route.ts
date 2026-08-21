import { NextResponse } from "next/server";

/**
 * `POST /api/tasks/:id/publish` — push the work branch, optionally open a PR.
 *
 * A proxy, deliberately. The work being published lives in a Docker volume, and
 * the worker is the only process that can reach one; the PAT that pushes it
 * never leaves that process either. So this route forwards to the worker's
 * control API rather than reimplementing any of it, and the browser keeps
 * talking to exactly one origin.
 *
 * The forward happens server-side, which is also what makes the worker's
 * control API safe to leave unauthenticated on loopback: it answers no CORS
 * headers, so the JSON content-type it requires means a page on another site
 * cannot reach it from the user's browser.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pushing a large repository is slower than a default fetch is patient. */
const PUBLISH_TIMEOUT_MS = 5 * 60 * 1000;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let body: { openPullRequest?: boolean; title?: string; body?: string } = {};
  try {
    const raw: unknown = await request.json();
    if (typeof raw === "object" && raw !== null) body = raw as typeof body;
  } catch {
    // An empty body means "just push"; that is a reasonable default, not an error.
  }

  const controlUrl = workerControlUrl();
  const abort = AbortSignal.timeout(PUBLISH_TIMEOUT_MS);

  try {
    const response = await fetch(`${controlUrl}/control/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: id,
        openPullRequest: body.openPullRequest === true,
        ...(body.title ? { title: body.title } : {}),
        ...(body.body ? { body: body.body } : {}),
      }),
      signal: abort,
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    // A worker that is not running is the single most likely cause, and it is
    // something the reader can act on -- unlike "fetch failed".
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
