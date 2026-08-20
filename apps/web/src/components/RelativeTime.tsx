"use client";

import { useEffect, useState } from "react";
import { formatDateTime, formatRelative } from "../lib/format";

/**
 * Renders the absolute UTC time on the server and upgrades to "4h ago" after
 * mount. Formatting relative to `Date.now()` during SSR would differ from the
 * value hydration computes and trip React's mismatch warning, so the absolute
 * form is the one both sides agree on.
 */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const absolute = formatDateTime(iso);
  const [label, setLabel] = useState(absolute);

  useEffect(() => {
    setLabel(formatRelative(iso));
    const id = setInterval(() => setLabel(formatRelative(iso)), 60_000);
    return () => clearInterval(id);
  }, [iso]);

  return (
    <time dateTime={iso} title={absolute} className={className}>
      {label}
    </time>
  );
}
