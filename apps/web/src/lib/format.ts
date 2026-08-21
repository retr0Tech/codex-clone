/**
 * Formatting helpers.
 *
 * Everything here is deterministic and pinned to UTC. Relative times ("4h ago")
 * are computed from `Date.now()`, which differs between the server render and
 * the client hydration and produces a mismatch warning; `RelativeTime` handles
 * that by rendering the absolute form first and upgrading after mount.
 */

const DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${DATE_TIME.format(d)} UTC`;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : TIME.format(d);
}

export function formatRelative(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDateTime(iso);
}

/** Durations read very differently at 60ms and at 94s; never print "94120ms". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** One-line preview of a tool's arguments, for the collapsed card header. */
export function summariseArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(key === "command" || key === "path" || key === "pattern" ? rendered : `${key}=${rendered}`);
  }
  const joined = parts.join("  ");
  return joined.length > 120 ? `${joined.slice(0, 119)}…` : joined;
}
