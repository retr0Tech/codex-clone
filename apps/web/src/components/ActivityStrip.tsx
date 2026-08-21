"use client";

import { useEffect, useState } from "react";
import type { RunPhase } from "@codex-clone/core";
import type { TranscriptItem } from "../lib/eventReducer";
import { Button } from "./ui/Button";
import { Spinner } from "./ui/misc";
import { formatDuration } from "../lib/format";
import { formatUsd } from "../lib/usage";

/**
 * What the agent is doing, directly above the box you type into.
 *
 * The run status already lives in the header, but that is the far corner of the
 * screen from where attention actually sits while waiting. A run is mostly
 * silence punctuated by tool calls, so "is it working or is it stuck?" is the
 * question this answers, and it has to be answerable without moving your eyes.
 *
 * Everything here is derived from the same folded transcript the messages come
 * from -- there is no second source of truth about liveness, so this strip
 * cannot claim the agent is working after the stream says otherwise.
 */
export function ActivityStrip({
  phase,
  items,
  costUsd,
  startedAt,
  cancelling,
  canCancel,
  onCancel,
}: {
  phase: RunPhase;
  items: readonly TranscriptItem[];
  costUsd: number;
  /** When the current run began, for the elapsed clock. Null before it starts. */
  startedAt: string | null;
  cancelling: boolean;
  canCancel: boolean;
  onCancel: () => void;
}) {
  const elapsed = useElapsed(startedAt);
  const activity = describeActivity(phase, items);

  return (
    <div
      className="flex items-center gap-2.5 rounded-t-xl border border-b-0 border-border-strong bg-surface-raised px-3 py-2 text-[12.5px]"
      // Announce transitions without stealing focus from the textarea.
      role="status"
      aria-live="polite"
    >
      <Spinner className="size-3.5 shrink-0 text-accent" />

      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-fg">{cancelling ? "Stopping" : activity.label}</span>
        {activity.detail ? (
          <span className="text-fg-muted"> · {activity.detail}</span>
        ) : null}
      </span>

      <span className="shrink-0 tabular-nums text-fg-faint">
        {elapsed === null ? null : formatDuration(elapsed)}
        {costUsd > 0 ? ` · ${formatUsd(costUsd)}` : ""}
      </span>

      {canCancel ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={cancelling}
          title={
            cancelling
              ? "Already stopping. The agent gets one final turn to commit what it has."
              : "Stop this run. The agent gets one final turn to commit partial work."
          }
          className="shrink-0"
        >
          {cancelling ? "Stopping…" : "Stop"}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * A phase is too coarse on its own: `agent` covers both "thinking" and "eight
 * seconds into a test run", which feel completely different to wait through.
 * So the phase picks the sentence and the newest unfinished item fills in what
 * is actually happening right now.
 */
export function describeActivity(
  phase: RunPhase,
  items: readonly TranscriptItem[],
): { label: string; detail: string | null } {
  switch (phase) {
    case "queued":
      return { label: "Queued", detail: "waiting for a free sandbox" };
    case "setup":
      return { label: "Preparing the workspace", detail: lastSetupLine(items) };
    case "finalizing":
      return { label: "Finishing up", detail: "deriving the diff" };
    case "done":
      return { label: "Wrapping up", detail: null };
    case "agent": {
      const pending = lastPendingTool(items);
      if (pending) return { label: `Running ${pending.tool}`, detail: toolDetail(pending) };
      if (isStreamingMessage(items)) return { label: "Writing", detail: null };
      return { label: "Thinking", detail: null };
    }
  }
}

/** The newest tool call with no result yet — the agent is inside it right now. */
function lastPendingTool(items: readonly TranscriptItem[]) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.kind === "tool") return item.result === null ? item : null;
  }
  return null;
}

function isStreamingMessage(items: readonly TranscriptItem[]): boolean {
  const last = items[items.length - 1];
  return last?.kind === "message" && last.streaming;
}

/**
 * One short, honest hint about the pending call. Arguments are agent-authored
 * and unbounded, so everything is clamped -- a strip that reflows the composer
 * is worse than one that says less.
 */
function toolDetail(item: { tool: string; args: Record<string, unknown> }): string | null {
  const candidate =
    firstString(item.args, ["command", "cmd", "pattern", "path", "file_path", "glob"]) ?? null;
  if (candidate === null) return null;
  const oneLine = candidate.replace(/\s+/g, " ").trim();
  if (oneLine === "") return null;
  return oneLine.length > 72 ? `${oneLine.slice(0, 71)}…` : oneLine;
}

function firstString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function lastSetupLine(items: readonly TranscriptItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.kind === "setup_log") {
      const line = [...item.lines].reverse().find((l) => l.text.trim() !== "");
      return line ? line.text.trim() : null;
    }
  }
  return null;
}

/**
 * Ticks once a second while a run is live. Deliberately not derived from the
 * event stream: a quiet minute inside one tool call would otherwise look
 * frozen, which is the exact anxiety this strip exists to remove.
 */
function useElapsed(startedAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (startedAt === null) return null;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  return Math.max(0, now - started);
}
