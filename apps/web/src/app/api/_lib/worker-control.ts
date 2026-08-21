import "server-only";

/**
 * Calling the worker's control API from a route handler.
 *
 * Archiving, restoring and rebasing all need the workspace VOLUME, and the
 * worker is the only process that can reach one -- so these routes forward
 * rather than reimplement, exactly as `POST /api/tasks/:id/publish` does. The
 * browser keeps talking to a single origin, and the forward happens
 * server-side, which is what makes the worker's control API safe to leave
 * unauthenticated on loopback: it answers no CORS headers, so the JSON content
 * type it requires means a page on another site cannot reach it from the user's
 * browser.
 */

/** Snapshotting a large repository is slower than a default fetch is patient. */
export const CONTROL_TIMEOUT_MS = 10 * 60 * 1000;

export interface ControlResponse {
  status: number;
  body: unknown;
}

export async function callWorker(path: string, payload: Record<string, unknown>): Promise<ControlResponse> {
  const controlUrl = workerControlUrl();
  try {
    const response = await fetch(`${controlUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    return { status: response.status, body: await response.json() };
  } catch (error) {
    // A worker that is not running is the single most likely cause, and it is
    // something the reader can act on -- unlike "fetch failed".
    return {
      status: 502,
      body: {
        error: `Could not reach the worker at ${controlUrl}. Is \`pnpm dev\` running? (${
          error instanceof Error ? error.message : String(error)
        })`,
      },
    };
  }
}

/**
 * The worker's control API shares the WebSocket port. `NEXT_PUBLIC_WS_URL` is
 * the one place that address is configured, so it is reused here rather than
 * introducing a second variable that can drift out of step with it.
 */
export function workerControlUrl(): string {
  const ws = process.env["NEXT_PUBLIC_WS_URL"] ?? "ws://127.0.0.1:8787";
  return ws.replace(/^ws/, "http").replace(/\/$/, "");
}
