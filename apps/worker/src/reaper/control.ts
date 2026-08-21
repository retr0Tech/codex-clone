import { redact } from "@codex-clone/core";
import { ArchiveError, archiveTask, rebaseOntoBase, unarchiveTask, type ArchiveDeps } from "./archive.js";
import { ReapBusyError } from "./reaper.js";

/**
 * The archive control API, mounted on the worker's existing control server.
 *
 * These live in the worker rather than in a Next.js route handler for the same
 * reason `POST /control/publish` does: every one of them needs the workspace
 * VOLUME, and the worker is the only process that can reach one. The web app
 * proxies here server-side, so the browser still talks to exactly one origin
 * and this server can stay unauthenticated on loopback -- it answers no CORS
 * headers, so the JSON content type it requires means no page on another site
 * can reach it from the user's browser.
 *
 * Handlers are a record rather than a router because that is the shape
 * `EventHub` already takes, and spreading one object into another is the whole
 * of the change this milestone needs in the worker's entrypoint.
 */

export type ControlHandler = (body: unknown) => Promise<{ status: number; body: unknown }>;

export function archiveRoutes(deps: ArchiveDeps): Record<string, ControlHandler> {
  const withTaskId =
    (what: string, run: (taskId: string) => Promise<unknown>): ControlHandler =>
    async (body) => {
      const input = body as { taskId?: unknown };
      if (typeof input?.taskId !== "string" || input.taskId === "") {
        return { status: 400, body: { error: "taskId is required" } };
      }
      try {
        return { status: 200, body: await run(input.taskId) };
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error));
        deps.log?.(`[worker] ${what} failed for ${input.taskId.slice(0, 8)}: ${message}`);
        // 409 is the one the UI acts on: it means "try again when the run
        // finishes", which is a different instruction from "this is broken".
        if (error instanceof ReapBusyError) return { status: 409, body: { error: message } };
        if (error instanceof ArchiveError) return { status: 400, body: { error: message } };
        return { status: 500, body: { error: message } };
      }
    };

  return {
    "POST /control/archive": withTaskId("archive", (taskId) => archiveTask(deps, taskId)),
    "POST /control/unarchive": withTaskId("unarchive", (taskId) => unarchiveTask(deps, taskId)),
    "POST /control/rebase": withTaskId("rebase", (taskId) => rebaseOntoBase(deps, taskId)),
  };
}
