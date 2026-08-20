"use client";

import { useEffect, useRef, type ReactNode, type UIEvent } from "react";

/**
 * Scroll container that follows a growing transcript, but stops following the
 * moment the reader scrolls up. Pinning unconditionally would yank the page out
 * from under someone reading an earlier tool result while the run continues.
 */
export function StickToBottom({
  dep,
  enabled = true,
  children,
  className,
}: {
  /** Bump this whenever content is appended — frame count, item count, etc. */
  dep: number;
  /** Off for panes that are not a growing log, such as the diff tab. */
  enabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || !pinned.current) return;
    el.scrollTop = el.scrollHeight;
  }, [dep, enabled]);

  function onScroll(event: UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    // 80px of slack, so a stray trackpad nudge does not unpin.
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  return (
    <div ref={ref} onScroll={onScroll} className={className}>
      {children}
    </div>
  );
}
