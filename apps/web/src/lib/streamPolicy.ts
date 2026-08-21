import type { ServerFrame } from "@codex-clone/core";

/**
 * The rules the socket client follows, pulled out of the hook so they can be
 * tested without a browser.
 *
 * All of them exist because of one property of `transcriptReducer`: a `hello`
 * frame RESETS it. That is the right behaviour for the reducer -- a
 * subscription must not inherit a previous one's half-transcript -- but it
 * makes *who* issues the hello a real decision, and the obvious answer is
 * wrong.
 *
 * The obvious answer is "dispatch the server's hello". It breaks, because the
 * page folds history over HTTP first and then connects with
 * `after=<lastSeq>`: the server's hello would clear those rows, and its
 * backfill only covers what comes AFTER the cursor, so the transcript would be
 * permanently empty. The same failure hits every reconnect.
 *
 * So the CLIENT owns the reset. It issues one opening hello of its own when a
 * subscription begins, and every hello the server sends after that is treated
 * as what it actually is -- a statement of how far the server's log goes, not
 * an instruction to forget anything.
 */

/** Backoff bounds. Fast enough to be invisible; capped so a dead worker is not hammered. */
export const RECONNECT_MIN_MS = 300;
export const RECONNECT_MAX_MS = 5_000;

/**
 * The client's own reset, dispatched once when a subscription starts.
 *
 * Deliberately a real `hello` frame rather than a bespoke action: the reducer
 * has exactly one door, and adding a second way to reset it would be the first
 * crack in "live and replayed run the same code".
 */
export function openingHello(taskId: string): ServerFrame {
  return { kind: "hello", taskId, runId: null, latestSeq: 0 };
}

/**
 * Whether a hello ARRIVING FROM THE SERVER should be fed to the reducer.
 *
 * Never. It carries `latestSeq`, which the UI wants for its catching-up
 * indicator, and nothing else the client does not already know. Feeding it in
 * would discard history the client has already folded -- see the module comment.
 * This is a function rather than a comment so the reasoning has a test attached.
 */
export function shouldDispatchServerHello(): boolean {
  return false;
}

/**
 * The cursor to resume from, advanced eagerly.
 *
 * Read from the socket's own callbacks rather than from rendered state: a drop
 * can happen between two messages, and the next connect must resume from what
 * actually arrived, not from whatever the last React render happened to see.
 */
export function advanceCursor(current: number, frame: ServerFrame): number {
  if (frame.kind !== "event") return current;
  return frame.event.seq > current ? frame.event.seq : current;
}

/** Exponential, capped. `attempt` is 1 for the first retry. */
export function reconnectDelayMs(attempt: number): number {
  if (attempt <= 1) return RECONNECT_MIN_MS;
  return Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** (attempt - 1));
}

/* -------------------------------------------------------------------------- */
/* Cancellation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Whether the UI should be showing "Cancelling…".
 *
 * There is no cancel acknowledgement on the wire, and there should not be: the
 * only frames the socket carries are durable events plus the one named
 * exception, token deltas (PLAN.md §3.6). Inventing a third ephemeral frame
 * kind for an ack would be the first crack in "everything broadcast is also
 * persisted". So the client remembers its own request, and the run winding down
 * IS the acknowledgement.
 *
 * That wind-down is not instant. The gateway meter closes immediately, so no
 * further model call is admitted even mid-turn -- but the agent is then given
 * one final turn to commit what it has before the container is stopped.
 * "Cancelling…" is therefore a real state lasting seconds, not a flicker.
 *
 * Two conditions beyond "the user clicked", and both matter:
 *
 *   requestedRunId === runId   a follow-up turn is a NEW run, and must not
 *                              inherit the previous run's pending cancel
 *   !terminal                  once the run has actually stopped, the status
 *                              badge is the truth and the spinner is a lie
 */
export function isCancelling(
  requestedRunId: string | null,
  runId: string | null,
  terminal: boolean,
): boolean {
  if (requestedRunId === null || runId === null) return false;
  return requestedRunId === runId && !terminal;
}
