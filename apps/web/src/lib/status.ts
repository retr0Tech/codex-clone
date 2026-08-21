import type { RunPhase, RunStatus } from "@codex-clone/core";
import type { Tone } from "../components/ui/Badge";

/**
 * One place that decides how a status looks and reads. Terminal states are
 * distinguished by tone, not only by wording, because "cancelled" and
 * "budget_exhausted" are very different signals to the person reading them.
 */
export const STATUS_META: Record<RunStatus, { label: string; tone: Tone; blurb: string }> = {
  queued: { label: "Queued", tone: "neutral", blurb: "Waiting for a sandbox slot." },
  running: { label: "Running", tone: "info", blurb: "The agent is working in its container." },
  succeeded: { label: "Succeeded", tone: "ok", blurb: "The agent finished on its own terms." },
  failed: { label: "Failed", tone: "danger", blurb: "The run ended on an error." },
  cancelled: { label: "Cancelled", tone: "warn", blurb: "Stopped from the UI. Partial work is kept." },
  timed_out: { label: "Timed out", tone: "warn", blurb: "Wall-clock budget reached." },
  budget_exhausted: { label: "Budget exhausted", tone: "warn", blurb: "Cost or turn ceiling reached." },
};

export const PHASE_META: Record<RunPhase, { label: string; blurb: string }> = {
  queued: { label: "Queued", blurb: "Claimed, waiting on a container." },
  setup: { label: "Setup", blurb: "Running the repo setup script in the sandbox." },
  agent: { label: "Agent", blurb: "The agent loop is running." },
  finalizing: { label: "Finalizing", blurb: "Deriving the diff and winding the container down." },
  done: { label: "Done", blurb: "Nothing further will be emitted for this run." },
};

export const TASK_STATUS_META: Record<
  "idle" | "queued" | "running" | "archived",
  { label: string; tone: Tone }
> = {
  idle: { label: "Idle", tone: "neutral" },
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "info" },
  archived: { label: "Archived", tone: "neutral" },
};
