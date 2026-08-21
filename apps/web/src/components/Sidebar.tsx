"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Label, Select } from "./ui/Field";
import { Badge } from "./ui/Badge";
import { ThemeToggle } from "./ThemeToggle";
import { cn } from "./ui/cn";
import { useWorkspace } from "./WorkspaceContext";
import { useScheduledJobs } from "../lib/useScheduledJobs";
import { useTasks } from "../lib/useTasks";
import { STATUS_META, TASK_STATUS_META } from "../lib/status";

function NavLink({
  href,
  icon,
  children,
  count,
  active,
}: {
  href: string;
  icon: ReactNode;
  children: ReactNode;
  count?: number;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors",
        active ? "bg-surface-3 font-medium text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      <span className={cn("shrink-0", active ? "text-fg" : "text-fg-faint")}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count !== undefined ? (
        <span className="font-mono text-[11px] tabular-nums text-fg-faint">{count}</span>
      ) : null}
    </Link>
  );
}

const ICON = "size-4";

const icons = {
  tasks: (
    <svg viewBox="0 0 16 16" className={ICON} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2.2" y="2.6" width="11.6" height="10.8" rx="2.2" />
      <path d="M5 6.4h6M5 9.4h3.8" strokeLinecap="round" />
    </svg>
  ),
  archived: (
    <svg viewBox="0 0 16 16" className={ICON} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2" y="3" width="12" height="3" rx="1" />
      <path d="M3.2 6.4v6a1.4 1.4 0 0 0 1.4 1.4h6.8a1.4 1.4 0 0 0 1.4-1.4v-6" />
      <path d="M6.5 9h3" strokeLinecap="round" />
    </svg>
  ),
  scheduled: (
    <svg viewBox="0 0 16 16" className={ICON} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="8" r="5.9" />
      <path d="M8 4.6V8l2.3 1.5" strokeLinecap="round" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 16 16" className={ICON} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.6v1.5M8 12.9v1.5M14.4 8h-1.5M3.1 8H1.6M12.5 3.5l-1 1M4.5 11.5l-1 1M12.5 12.5l-1-1M4.5 4.5l-1-1" strokeLinecap="round" />
    </svg>
  ),
  play: (
    <svg viewBox="0 0 16 16" className={ICON} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="8" r="5.9" />
      <path d="M6.6 5.6 10.4 8l-3.8 2.4Z" fill="currentColor" />
    </svg>
  ),
  usage: (
    <svg viewBox="0 0 16 16" className={ICON} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M2.4 13.4h11.2" strokeLinecap="round" />
      <path d="M4.4 11.4V7.2M8 11.4V3.4M11.6 11.4V8.8" strokeLinecap="round" />
    </svg>
  ),
};

export function Sidebar() {
  const pathname = usePathname();
  const { repos, repo, branches, branch, loadingRepos, error, setRepoFullName, setBranch, refreshRepos } =
    useWorkspace();
  const { tasks } = useTasks();
  // Real rows now, not fixtures: the badge is a count of schedules that exist.
  const { jobs: scheduledJobs } = useScheduledJobs();

  const active = tasks.filter((t) => t.status !== "archived");
  const archived = tasks.filter((t) => t.status === "archived");
  // Scoped to the selected repository: the sidebar answers "what is happening
  // in the thing I am looking at", and the home page answers "everything".
  const repoTasks = repo ? active.filter((t) => t.repoFullName === repo.fullName) : [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <Link href="/" className="flex items-center gap-2 rounded-md px-1 py-1">
          <span className="grid size-5 place-items-center rounded bg-fg text-[10px] font-bold text-bg">C</span>
          <span className="text-[13px] font-semibold tracking-tight">codex-clone</span>
        </Link>
        <ThemeToggle />
      </div>

      <div className="shrink-0 border-b border-border px-3 py-3">
        <Label htmlFor="sidebar-repo">Repository</Label>
        <Select
          id="sidebar-repo"
          value={repo?.fullName ?? ""}
          onChange={(e) => setRepoFullName(e.target.value)}
          disabled={repos.length === 0}
          className="mb-2"
        >
          {repos.length === 0 ? <option value="">{loadingRepos ? "loading…" : "none"}</option> : null}
          {repos.map((r) => (
            <option key={r.fullName} value={r.fullName}>
              {r.fullName}
            </option>
          ))}
        </Select>
        <Label htmlFor="sidebar-branch">Base branch</Label>
        <Select
          id="sidebar-branch"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          disabled={branches.length === 0}
        >
          {branches.length === 0 && branch !== "" ? <option value={branch}>{branch}</option> : null}
          {branches.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
        </Select>
        {error ? (
          <p className="mt-2 text-[11px] leading-4 text-warn">{error}</p>
        ) : (
          <p className="mt-2 truncate font-mono text-[11px] text-fg-faint" title={repo?.setupScript ?? undefined}>
            setup: {repo?.setupScript ?? "none configured"}
          </p>
        )}
        <button
          type="button"
          onClick={refreshRepos}
          className="mt-2 text-[11px] text-fg-faint underline-offset-2 hover:text-fg hover:underline"
        >
          Refresh from GitHub
        </button>
      </div>

      <nav className="shrink-0 space-y-0.5 px-2 py-2">
        <NavLink href="/" icon={icons.tasks} active={pathname === "/"} count={active.length}>
          Tasks
        </NavLink>
        <NavLink
          href="/archived"
          icon={icons.archived}
          active={pathname.startsWith("/archived")}
          count={archived.length}
        >
          Archived
        </NavLink>
        <NavLink
          href="/scheduled"
          icon={icons.scheduled}
          active={pathname.startsWith("/scheduled")}
          count={scheduledJobs.length}
        >
          Scheduled
        </NavLink>
        {/* Milestone 10. The gateway has been metering every run since
            milestone 4; this is where those figures finally surface. */}
        <NavLink href="/usage" icon={icons.usage} active={pathname.startsWith("/usage")}>
          Usage
        </NavLink>
        {/* Wave A owns the Settings page; this only links to the route. */}
        <NavLink href="/settings" icon={icons.settings} active={pathname.startsWith("/settings")}>
          Settings
        </NavLink>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-2 py-2">
        <p className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-faint">
          {repo ? (repo.fullName.split("/")[1] ?? repo.fullName) : "tasks"}
        </p>
        {repoTasks.length === 0 ? (
          <p className="px-2 py-3 text-[12.5px] text-fg-faint">No tasks in this repo yet.</p>
        ) : (
          <ul className="space-y-0.5">
            {repoTasks.map((task) => {
              const current = pathname === `/tasks/${task.id}`;
              const inFlight = task.status === "queued" || task.status === "running";
              // In flight: say where it is in the queue. Finished: say how the
              // last run ended, which is the more useful fact by then.
              const meta = inFlight
                ? TASK_STATUS_META[task.status]
                : task.latestRun
                  ? STATUS_META[task.latestRun.status]
                  : null;
              return (
                <li key={task.id}>
                  <Link
                    href={`/tasks/${task.id}`}
                    aria-current={current ? "page" : undefined}
                    className={cn(
                      "block rounded-md px-2 py-1.5 transition-colors",
                      current ? "bg-surface-3" : "hover:bg-surface-2",
                    )}
                  >
                    <span
                      className={cn(
                        "block truncate text-[12.5px] leading-5",
                        current ? "font-medium text-fg" : "text-fg-muted",
                      )}
                    >
                      {task.title}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5">
                      <span className="font-mono text-[10.5px] text-fg-faint">{task.baseBranch}</span>
                      {meta ? (
                        <Badge tone={meta.tone} dot={inFlight}>
                          {meta.label}
                        </Badge>
                      ) : null}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-2 py-2">
        <NavLink href="/mock/transcript" icon={icons.play} active={pathname.startsWith("/mock")}>
          Mock playback
        </NavLink>
        <p className="px-2 pt-1.5 text-[11px] leading-4 text-fg-faint">
          A recorded run, replayed through the same reducer the live socket feeds.
        </p>
      </div>
    </div>
  );
}
