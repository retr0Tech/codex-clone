"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { TaskList } from "../../components/TaskList";
import { Button } from "../../components/ui/Button";
import { formatBytes, type ArchivedTask } from "./format";

/**
 * The archived list, with a Restore button per row.
 *
 * Restoring is a status change and nothing more: the task returns to the
 * sidebar immediately, and its workspace comes back from the cold snapshot on
 * the next turn, through the same wake path the idle reaper's round trip uses.
 * There is deliberately no "restore and rebase" here -- the base branch may
 * have moved, and choosing that for the user is how work gets lost. The rebase
 * is its own button on the task page.
 */

export function ArchivedList({ rows }: { rows: ArchivedTask[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const restore = useCallback(
    async (taskId: string) => {
      if (busy) return;
      setBusy(taskId);
      setError(null);
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/archive`, { method: "DELETE" });
        const body = (await response.json()) as { error?: string };
        if (!response.ok) {
          setError(body.error ?? `restoring failed with ${response.status}`);
          return;
        }
        router.refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(null);
      }
    },
    [busy, router],
  );

  const bySize = new Map(rows.map((row) => [row.task.id, row.snapshot]));

  return (
    <>
      {error ? (
        <p className="mb-3 rounded-md border border-danger/40 bg-danger-soft px-2.5 py-1.5 text-[12px] text-danger">
          {error}
        </p>
      ) : null}
      <TaskList
        tasks={rows.map((row) => row.task)}
        showArchived
        empty={{
          title: "Nothing archived",
          body: "Archiving a task keeps its transcript in full and exports its workspace to a cold snapshot, then frees the Docker volume. Restoring brings both back.",
        }}
        action={(task) => {
          const snapshot = bySize.get(task.id);
          return (
            <div className="flex items-center gap-3">
              <span className="hidden font-mono text-[11px] tabular-nums text-fg-faint sm:block">
                {snapshot ? formatBytes(snapshot.sizeBytes) : "no snapshot"}
              </span>
              <Button size="sm" variant="secondary" onClick={() => void restore(task.id)} disabled={busy !== null}>
                {busy === task.id ? "Restoring…" : "Restore"}
              </Button>
            </div>
          );
        }}
      />
    </>
  );
}
