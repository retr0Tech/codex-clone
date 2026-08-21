"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import type { TaskView } from "../../lib/types";
import { Button } from "../ui/Button";
import { shortSha } from "../../lib/format";

/**
 * Archive, restore, and the explicit rebase (PLAN.md §3.10).
 *
 * All three are worker calls, not database writes: archiving exports the
 * workspace volume to the cold snapshot store before it drops it, and only the
 * worker can reach a volume. The web app proxies server-side.
 *
 * The rebase is a separate button on purpose. Restoring an archived task
 * recreates the workspace **as it was**, on the commit it was pinned to. A base
 * branch that has moved since is a fact the user may want and may not, and
 * replaying their work onto a commit they have not seen -- silently, as a side
 * effect of clicking Restore -- is how a tool loses somebody's work. So it is
 * offered, named, and never automatic.
 */

export type ArchiveAction = "archive" | "restore" | "rebase";

interface RebaseBody {
  rebased?: boolean;
  baseSha?: string;
  baseBranch?: string;
  error?: string;
}

export function ArchiveActions({
  task,
  running,
  onNotice,
  onError,
}: {
  task: TaskView;
  /** A run in flight: archiving or rebasing under one would race the agent. */
  running: boolean;
  onNotice: (message: string | null) => void;
  onError: (message: string | null) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<ArchiveAction | null>(null);

  const call = useCallback(
    async (action: ArchiveAction) => {
      if (busy || running) return;
      setBusy(action);
      onError(null);
      onNotice(
        action === "archive"
          ? "Exporting the workspace to the cold snapshot store…"
          : action === "restore"
            ? "Restoring…"
            : "Fetching the base branch and replaying the work branch…",
      );
      try {
        const response = await fetch(
          `/api/tasks/${encodeURIComponent(task.id)}/${action === "rebase" ? "rebase" : "archive"}`,
          { method: action === "restore" ? "DELETE" : "POST" },
        );
        const body = (await response.json()) as RebaseBody;
        if (!response.ok) {
          onNotice(null);
          onError(body.error ?? `${action} failed with ${response.status}`);
          return;
        }
        onNotice(describe(action, body));
        router.refresh();
      } catch (error) {
        onNotice(null);
        onError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(null);
      }
    },
    [busy, running, task.id, router, onError, onNotice],
  );

  if (task.status === "archived") {
    return (
      <Button
        size="sm"
        variant="primary"
        onClick={() => void call("restore")}
        disabled={busy !== null}
        title="Returns the task to the sidebar. The workspace is restored from its cold snapshot on the next turn."
      >
        {busy === "restore" ? "Restoring…" : "Restore"}
      </Button>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void call("rebase")}
        disabled={busy !== null || running || !task.workBranch}
        title={
          running
            ? "Wait for the run to finish: a rebase rewrites .git in the workspace volume"
            : !task.workBranch
              ? "Run the task once first — there is no work branch to rebase yet"
              : `Replays this task's work onto the latest ${task.baseBranch}, and moves the pinned base SHA with it`
        }
      >
        {busy === "rebase" ? "Rebasing…" : `Rebase onto ${task.baseBranch}`}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void call("archive")}
        disabled={busy !== null || running}
        title={
          running
            ? "Wait for the run to finish: archiving exports the workspace volume and then removes it"
            : "Keeps the transcript and a cold snapshot of the workspace, and frees the Docker volume"
        }
      >
        {busy === "archive" ? "Archiving…" : "Archive"}
      </Button>
    </>
  );
}

function describe(action: ArchiveAction, body: RebaseBody): string {
  if (action === "archive") {
    return "Archived. The transcript and a cold snapshot of the workspace are kept; the Docker volume is gone.";
  }
  if (action === "restore") {
    return "Restored. The workspace comes back from its cold snapshot on the next turn.";
  }
  if (body.rebased === false) {
    return `Already on the latest ${body.baseBranch ?? "base branch"}; nothing was replayed.`;
  }
  return `Rebased onto ${body.baseBranch ?? "the base branch"} at ${shortSha(body.baseSha ?? "")}. The pinned base SHA moved with it, so the next diff is measured against the new base.`;
}
