/**
 * The event log is the single source of truth for a run's transcript.
 *
 * Invariant: a live WebSocket frame and a row returned by the history endpoint
 * are the SAME shape, so one reducer renders both. Nothing may be broadcast
 * live that is not also persisted -- with the single, explicit exception of
 * token deltas (see `DeltaFrame`), which are an optimistic overlay only.
 */

/** Phases a run moves through. `setup` covers dependency install. */
export type RunPhase = "queued" | "setup" | "agent" | "finalizing" | "done";

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "budget_exhausted";

export type ToolName = "shell" | "apply_patch" | "read_file" | "grep";

export type DurableEventType =
  | "phase"
  | "setup_log"
  | "reasoning"
  | "message"
  | "tool_call"
  | "tool_result"
  | "diff"
  | "status"
  | "error";

export interface EventPayloadMap {
  phase: { phase: RunPhase };
  /** stdout/stderr of the repo setup script, streamed as its own phase. */
  setup_log: { stream: "stdout" | "stderr"; text: string };
  reasoning: { text: string };
  /** Final, coalesced assistant text. Supersedes any DeltaFrame overlay. */
  message: { messageId: string; role: "assistant" | "user"; text: string };
  tool_call: { callId: string; tool: ToolName; args: Record<string, unknown> };
  tool_result: {
    callId: string;
    tool: ToolName;
    ok: boolean;
    /** Truncated for transport; full output lives in object storage if large. */
    output: string;
    truncated: boolean;
    exitCode?: number;
    durationMs: number;
  };
  /**
   * Derived by the HOST via `git diff <baseSha>` after each turn -- never
   * reported by the agent. The diff view therefore shows reality, not claims.
   */
  diff: {
    baseSha: string;
    files: Array<{ path: string; additions: number; deletions: number; status: "added" | "modified" | "deleted" | "renamed" }>;
    patch: string;
    truncated: boolean;
  };
  status: { status: RunStatus; reason?: string };
  error: { code: string; message: string; retryable: boolean };
}

/**
 * One row of the append-only event log. `seq` is monotonic per run and is the
 * cursor used for backfill and reconnect.
 */
export interface EventRow<T extends DurableEventType = DurableEventType> {
  seq: number;
  runId: string;
  taskId: string;
  type: T;
  payload: EventPayloadMap[T];
  createdAt: string;
}

export type AnyEventRow = { [K in DurableEventType]: EventRow<K> }[DurableEventType];

/**
 * Ephemeral token-level overlay. NEVER persisted. The client renders these
 * optimistically and discards them the moment the durable `message` event with
 * the matching messageId arrives.
 */
export interface DeltaFrame {
  kind: "delta";
  runId: string;
  messageId: string;
  text: string;
}

export interface EventFrame {
  kind: "event";
  event: AnyEventRow;
}

/** Sent once on connect, before backfill, so the client can reset its reducer. */
export interface HelloFrame {
  kind: "hello";
  taskId: string;
  runId: string | null;
  /** Highest seq the server holds; client knows when backfill is complete. */
  latestSeq: number;
}

export type ServerFrame = HelloFrame | EventFrame | DeltaFrame;

/** Client -> server. The cancel channel is why this transport is a socket. */
export type ClientFrame =
  | { kind: "subscribe"; taskId: string; after: number }
  | { kind: "cancel"; runId: string };
