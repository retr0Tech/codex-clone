"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { AnyEventRow, ServerFrame } from "@codex-clone/core";
import {
  eventFrame,
  initialTranscriptState,
  transcriptReducer,
  type TranscriptState,
} from "./eventReducer";
import { advanceCursor, reconnectDelayMs, shouldResetOnHello } from "./streamPolicy";

/**
 * The live transcript, over the worker's WebSocket.
 *
 * This is the seam `useMockStream` was standing in for, and the swap is
 * deliberately shallow: both dispatch into the SAME `transcriptReducer`. That
 * is the whole point of PLAN.md §3.6 -- history rows and live frames are the
 * identical `{seq, type, payload}` shape, so replay and live rendering run
 * identical code over identical data and are structurally incapable of drifting.
 * `foldThenReplayEquivalence` in eventReducer.test.ts is the proof, and it only
 * means anything as long as there is exactly one reducer.
 *
 * Sequence of a connect:
 *
 *   GET /api/tasks/:id/events?after=0     paint immediately from history
 *        ▼
 *   ws://…?taskId=…&after=<lastSeq>       hello, backfill the gap, go live
 *        ▼
 *   reconnect on drop, after=<lastSeq>    resumes exactly where it stopped
 *
 * History first, then the socket, because a page load should render without
 * waiting on a WebSocket handshake -- and because it exercises the equivalence
 * claim on every single page view rather than only in a test.
 */

export type ConnectionState = "connecting" | "live" | "reconnecting";

export interface TranscriptStream {
  state: TranscriptState;
  connection: ConnectionState;
  /** True while the client is still catching up on the server's backlog. */
  backfilling: boolean;
  /** Highest seq the server says it holds. Updated on every hello. */
  serverLatestSeq: number;
  /** Non-null when history could not be loaded at all. */
  error: string | null;
  cancel: (runId: string) => void;
}

export function useTranscriptStream({ taskId, wsUrl }: { taskId: string; wsUrl: string }): TranscriptStream {
  const [state, dispatch] = useReducer(transcriptReducer, initialTranscriptState);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [serverLatestSeq, setServerLatestSeq] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  // The reconnect cursor, mirrored out of reducer state so the socket's
  // `onclose` can read it without the effect closing over a stale render.
  const lastSeqRef = useRef(0);
  // Whether this connection has already introduced itself for this task. A
  // second hello for the same task is a RECONNECT, and must not reset.
  const helloSeenRef = useRef(false);

  useEffect(() => {
    lastSeqRef.current = state.lastSeq;
  }, [state.lastSeq]);

  const cancel = useCallback((runId: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ kind: "cancel", runId }));
  }, []);

  useEffect(() => {
    if (taskId === "") return;

    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    lastSeqRef.current = 0;
    helloSeenRef.current = false;
    setConnection("connecting");

    /**
     * History over HTTP. Folded through `eventFrame()` so it enters the reducer
     * through the same door as a live frame -- there is deliberately no second
     * "replay" path to fall out of sync with.
     */
    const loadHistory = async () => {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/events?after=0`, {
        cache: "no-store",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `history request failed with ${response.status}`);
      }
      const rows = (await response.json()) as AnyEventRow[];
      if (disposed) return;
      for (const row of rows) {
        dispatch(eventFrame(row));
        // Advanced here rather than waiting for the reducer's state to land in
        // a render: `connect()` runs immediately after this and needs the
        // cursor NOW, or it would ask the socket to resend everything.
        lastSeqRef.current = advanceCursor(lastSeqRef.current, eventFrame(row));
      }
    };

    const connect = () => {
      if (disposed) return;
      const url = `${wsUrl.replace(/\/$/, "")}/?taskId=${encodeURIComponent(taskId)}&after=${lastSeqRef.current}`;
      socket = new WebSocket(url);
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) return;
        attempt = 0;
        setConnection("live");
        setError(null);
      };

      socket.onmessage = (message: MessageEvent<string>) => {
        if (disposed) return;
        let frame: ServerFrame;
        try {
          frame = JSON.parse(message.data) as ServerFrame;
        } catch {
          // A frame we cannot parse is a frame we cannot act on. Dropping it is
          // safe: the reconnect cursor will fetch anything durable again.
          return;
        }

        if (frame.kind === "hello") {
          setServerLatestSeq(frame.latestSeq);
          // See streamPolicy.ts: the reducer resets on hello, which is right
          // for a first connect and wrong for a reconnect.
          const reset = shouldResetOnHello(helloSeenRef.current);
          helloSeenRef.current = true;
          if (!reset) return;
        }
        // Same reason as the history fold: a drop can happen between two
        // messages and the next connect must resume from the real cursor, not
        // from whatever the last render happened to see.
        lastSeqRef.current = advanceCursor(lastSeqRef.current, frame);
        dispatch(frame);
      };

      socket.onerror = () => {
        // `onclose` always follows, and that is where the retry lives; doing it
        // in both places produces two sockets.
      };

      socket.onclose = () => {
        if (disposed) return;
        socketRef.current = null;
        setConnection("reconnecting");
        attempt += 1;
        retryTimer = setTimeout(connect, reconnectDelayMs(attempt));
      };
    };

    loadHistory()
      .catch((err: unknown) => {
        if (disposed) return;
        // A failed history load is not fatal: the socket backfills from 0 on
        // its own. Surface it, then carry on.
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!disposed) connect();
      });

    return () => {
      disposed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      if (socket) {
        // Drop the handlers first: a close we asked for must not schedule a
        // reconnect from a component that is going away.
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close(1000, "component unmounted");
      }
      socketRef.current = null;
    };
  }, [taskId, wsUrl]);

  return {
    state,
    connection,
    backfilling: serverLatestSeq > 0 && state.lastSeq < serverLatestSeq,
    serverLatestSeq,
    error,
    cancel,
  };
}
