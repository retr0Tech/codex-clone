"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Label, Select } from "./ui/Field";
import { Badge } from "./ui/Badge";
import { ThemeToggle } from "./ThemeToggle";
import { cn } from "./ui/cn";
import { useWorkspace } from "./WorkspaceContext";
import { mockArchivedTasks, mockScheduledJobs, mockTasks } from "../mocks/data";
import { TASK_STATUS_META } from "../lib/status";

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
};

export function Sidebar() {
  const pathname = usePathname();
  const { repos, repo, branch, setRepoId, setBranch } = useWorkspace();
  const repoTasks = mockTasks.filter((t) => t.repoId === repo.id);

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
        <Select id="sidebar-repo" value={repo.id} onChange={(e) => setRepoId(e.target.value)} className="mb-2">
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.fullName}
            </option>
          ))}
        </Select>
        <Label htmlFor="sidebar-branch">Base branch</Label>
        <Select id="sidebar-branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
          {repo.branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </Select>
        <p className="mt-2 truncate font-mono text-[11px] text-fg-faint" title={repo.setupScript}>
          setup: {repo.setupScript}
        </p>
      </div>

      <nav className="shrink-0 space-y-0.5 px-2 py-2">
        <NavLink href="/" icon={icons.tasks} active={pathname === "/"} count={mockTasks.length}>
          Tasks
        </NavLink>
        <NavLink
          href="/archived"
          icon={icons.archived}
          active={pathname.startsWith("/archived")}
          count={mockArchivedTasks.length}
        >
          Archived
        </NavLink>
        <NavLink
          href="/scheduled"
          icon={icons.scheduled}
          active={pathname.startsWith("/scheduled")}
          count={mockScheduledJobs.length}
        >
          Scheduled
        </NavLink>
        {/* Wave A owns the Settings page; this only links to the route. */}
        <NavLink href="/settings" icon={icons.settings} active={pathname.startsWith("/settings")}>
          Settings
        </NavLink>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-2 py-2">
        <p className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-faint">
          {repo.fullName.split("/")[1]}
        </p>
        {repoTasks.length === 0 ? (
          <p className="px-2 py-3 text-[12.5px] text-fg-faint">No tasks in this repo yet.</p>
        ) : (
          <ul className="space-y-0.5">
            {repoTasks.map((task) => {
              const active = pathname === `/tasks/${task.id}`;
              const meta = TASK_STATUS_META[task.status];
              return (
                <li key={task.id}>
                  <Link
                    href={`/tasks/${task.id}`}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block rounded-md px-2 py-1.5 transition-colors",
                      active ? "bg-surface-3" : "hover:bg-surface-2",
                    )}
                  >
                    <span
                      className={cn(
                        "block truncate text-[12.5px] leading-5",
                        active ? "font-medium text-fg" : "text-fg-muted",
                      )}
                    >
                      {task.title}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5">
                      <span className="font-mono text-[10.5px] text-fg-faint">{task.baseBranch}</span>
                      {task.status !== "idle" ? (
                        <Badge tone={meta.tone} dot>
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
          No backend yet &mdash; every view here is folded from local fixtures.
        </p>
      </div>
    </div>
  );
}
