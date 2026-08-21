"use client";

import { useState, type ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { WorkspaceProvider } from "./WorkspaceContext";
import { cn } from "./ui/cn";

/**
 * Two panes: a fixed sidebar and a scrolling main column. The page itself never
 * scrolls, so the composer and the transcript header stay put while a long run
 * streams underneath them.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <WorkspaceProvider>
      <div className="flex h-dvh overflow-hidden bg-bg">
        <aside
          className={cn(
            "w-[264px] shrink-0 border-r border-border bg-bg-sunken",
            "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-40 max-lg:transition-transform",
            navOpen ? "max-lg:translate-x-0" : "max-lg:-translate-x-full",
          )}
        >
          <Sidebar />
        </aside>

        {navOpen ? (
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
            className="fixed inset-0 z-30 bg-black/30 lg:hidden"
          />
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3 text-[13px] text-fg-muted lg:hidden"
          >
            <svg viewBox="0 0 16 16" className="size-4" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2.5 4h11M2.5 8h11M2.5 12h11" strokeLinecap="round" />
            </svg>
            Menu
          </button>
          <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>
    </WorkspaceProvider>
  );
}
