import Link from "next/link";
import type { MockTask } from "../mocks/data";
import { repoById } from "../mocks/data";
import { runsForTask } from "../mocks/runs";
import { Badge } from "./ui/Badge";
import { DiffStat } from "./ui/misc";
import { RelativeTime } from "./RelativeTime";
import { STATUS_META, TASK_STATUS_META } from "../lib/status";
import { cn } from "./ui/cn";

/**
 * One row per task. The status shown is the *last run's* outcome rather than
 * the task record's own status, because "cancelled" and "budget exhausted" are
 * what the reader needs at a glance and the task row only knows idle/running.
 */
export function TaskRow({ task, showArchived = false }: { task: MockTask; showArchived?: boolean }) {
  const repo = repoById(task.repoId);
  const runs = runsForTask(task.id);
  const lastRun = runs[runs.length - 1];
  const runMeta = lastRun ? STATUS_META[lastRun.status] : null;
  const taskMeta = TASK_STATUS_META[task.status];

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
          <p className="mt-0.5 truncate text-[12.5px] text-fg-muted">{task.summary}</p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {task.filesChanged > 0 ? <DiffStat additions={task.additions} deletions={task.deletions} /> : null}
          <span className="hidden font-mono text-[11.5px] text-fg-faint md:block">
            {repo?.fullName.split("/")[1]}:{task.baseBranch}
          </span>
          {task.status === "queued" || task.status === "running" || task.status === "archived" ? (
            <Badge tone={taskMeta.tone} dot={task.status !== "archived"}>
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

export function TaskList({ tasks, showArchived = false }: { tasks: MockTask[]; showArchived?: boolean }) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} showArchived={showArchived} />
      ))}
    </ul>
  );
}
