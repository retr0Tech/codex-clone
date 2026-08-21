import Link from "next/link";
import type { TaskView } from "../lib/types";
import { Badge } from "./ui/Badge";
import { RelativeTime } from "./RelativeTime";
import { STATUS_META, TASK_STATUS_META } from "../lib/status";
import { cn } from "./ui/cn";
import { EmptyState } from "./ui/misc";

/**
 * One row per task.
 *
 * The badge prefers the *last run's* outcome over the task record's own status,
 * because "cancelled" and "budget exhausted" are what the reader needs at a
 * glance and the task row only knows idle/queued/running/archived. While a run
 * is in flight the task status wins, since that is the one that says whether it
 * is waiting for a sandbox slot or already has one.
 */
export function TaskRow({ task, showArchived = false }: { task: TaskView; showArchived?: boolean }) {
  const runMeta = task.latestRun ? STATUS_META[task.latestRun.status] : null;
  const taskMeta = TASK_STATUS_META[task.status];
  const inFlight = task.status === "queued" || task.status === "running";

  return (
    <li>
      <Link
        href={`/tasks/${task.id}`}
        className={cn(
          "group flex flex-col gap-1.5 px-4 py-3 transition-colors hover:bg-surface-2",
          "sm:flex-row sm:items-center sm:gap-4",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-medium text-fg">{task.title}</span>
            {task.mode === "ask" ? <Badge tone="neutral">Ask</Badge> : null}
          </div>
          <p className="mt-0.5 truncate text-[12.5px] text-fg-muted">
            {task.latestRun?.stopReason ?? task.latestRun?.prompt ?? "No runs yet."}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden font-mono text-[11.5px] text-fg-faint md:block">
            {task.repoFullName.split("/")[1]}:{task.baseBranch}
          </span>
          {inFlight || task.status === "archived" ? (
            <Badge tone={taskMeta.tone} dot={inFlight}>
              {taskMeta.label}
            </Badge>
          ) : runMeta ? (
            <Badge tone={runMeta.tone} dot>
              {runMeta.label}
            </Badge>
          ) : (
            <Badge tone="neutral">No runs</Badge>
          )}
          <RelativeTime
            iso={showArchived ? (task.archivedAt ?? task.lastActivityAt) : task.lastActivityAt}
            className="w-16 shrink-0 text-right text-[11.5px] tabular-nums text-fg-faint"
          />
        </div>
      </Link>
    </li>
  );
}

export function TaskList({
  tasks,
  showArchived = false,
  empty,
}: {
  tasks: TaskView[];
  showArchived?: boolean;
  empty?: { title: string; body: string };
}) {
  if (tasks.length === 0 && empty) {
    return <EmptyState title={empty.title} body={empty.body} />;
  }
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} showArchived={showArchived} />
      ))}
    </ul>
  );
}
