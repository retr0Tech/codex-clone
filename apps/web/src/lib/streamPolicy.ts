import type { ServerFrame } from "@codex-clone/core";

/**
 * The two decisions the socket client makes that are easy to get wrong, pulled
 * out of the hook so they can be tested without a browser.
 *
 * Both exist because of one property of the reducer: `transcriptReducer` RESETS
 * on a `hello` frame. That is correct for a first connect and for switching
 * tasks -- a stale half-transcript from a previous subscription must not
 * survive -- and it is exactly wrong for a reconnect, where the server is
 * backfilling only the gap after `after=<seq>` and a reset would discard
 * everything before it.
 */

/** Backoff bounds. Fast enough to be invisible; capped so a dead worker is not hammered. */
export const RECONNECT_MIN_MS = 300;
export const RECONNECT_MAX_MS = 5_000;

/**
 * Whether a `hello` should be fed to the reducer.
 *
 * First hello for a subscription: yes, reset. Any later one on the same
 * subscription is a reconnect and must be suppressed.
 */
export function shouldResetOnHello(seenHelloAlready: boolean): boolean {
  return !seenHelloAlready;
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
