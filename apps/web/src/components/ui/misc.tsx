import type { ReactNode } from "react";
import { cn } from "./cn";

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cn("size-3.5 animate-spin", className)} aria-hidden>
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2" />
      <path d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border-strong bg-surface-2 px-1.5 py-px font-sans text-[11px] font-medium text-fg-muted">
      {children}
    </kbd>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <p className="text-[14px] font-medium text-fg">{title}</p>
      <p className="mx-auto mt-1.5 max-w-md text-[13px] text-fg-muted">{body}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function SectionHeading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-4">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-faint">{children}</h2>
      {aside}
    </div>
  );
}

/** +N / -M, the pair you actually scan for in a change list. */
export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="font-mono text-[11.5px] tabular-nums whitespace-nowrap">
      <span className="text-add-fg">+{additions}</span>{" "}
      <span className="text-del-fg">&minus;{deletions}</span>
    </span>
  );
}
