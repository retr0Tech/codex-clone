import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Collapsible built on <details>, so it is keyboard- and find-in-page-friendly
 * with no state to manage and no hydration cost.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className,
  bodyClassName,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <details open={defaultOpen} className={className}>
      <summary className="flex items-center gap-2 select-none">
        {/* Rotation is driven by a `details[open] > summary` rule rather than
            Tailwind's group-open variant: these nest, and `group-open` matches
            ANY open ancestor group, so an inner chevron would flip whenever the
            outer disclosure was expanded. */}
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className="disclosure-chevron size-3 shrink-0 text-fg-faint transition-transform"
        >
          <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span className="min-w-0 flex-1">{summary}</span>
      </summary>
      <div className={cn("mt-2", bodyClassName)}>{children}</div>
    </details>
  );
}
