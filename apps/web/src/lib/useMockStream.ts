"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { AnyEventRow } from "@codex-clone/core";
import { eventFrame, initialTranscriptState, transcriptReducer, type TranscriptState } from "./eventReducer";
import type { PlaybackFrame } from "../mocks/builder";

/**
 * The seam where the real WebSocket will land.
 *
 * Both modes below dispatch into the same `transcriptReducer`, which is the
 * entire point: "live" walks the fixture's frame script on timers exactly as
 * the socket would, "history" folds only the durable rows exactly as a page
 * reload would. When the hub from milestone 6 exists, `live` becomes an
 * onmessage handler and `history` becomes a fetch — neither changes what the
 * reducer sees, and neither can therefore render something the other cannot.
 */
export type StreamMode = "live" | "history";

export interface MockStream {
  state: TranscriptState;
  mode: StreamMode;
  setMode: (mode: StreamMode) => void;
  speed: number;
  setSpeed: (speed: number) => void;
  /** Frames delivered so far, for the progress affordance. */
  delivered: number;
  total: number;
  playing: boolean;
  restart: () => void;
}

export function useMockStream({
  taskId,
  runId,
  frames,
  history,
  initialMode = "history",
}: {
  taskId: string;
  runId: string | null;
  frames: readonly PlaybackFrame[];
  history: readonly AnyEventRow[];
  initialMode?: StreamMode;
}): MockStream {
  const [state, dispatch] = useReducer(transcriptReducer, initialTranscriptState);
  const [mode, setMode] = useState<StreamMode>(initialMode);
  const [speed, setSpeed] = useState(4);
  const [token, setToken] = useState(0);
  const [delivered, setDelivered] = useState(0);
  const [playing, setPlaying] = useState(false);

  const latestSeq = history.length === 0 ? 0 : (history[history.length - 1]?.seq ?? 0);

  // Speed is read through a ref rather than closed over, so dragging it from 1×
  // to 16× changes the pace of the run in flight instead of restarting it.
  const speedRef = useRef(speed);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  useEffect(() => {
    // Every (re)start begins with the hello frame, same as a real connect: it
    // resets the reducer so a mode switch cannot inherit half a transcript.
    dispatch({ kind: "hello", taskId, runId, latestSeq });
    setDelivered(0);

    if (mode === "history") {
      for (const event of history) dispatch(eventFrame(event));
      setDelivered(frames.length);
      setPlaying(false);
      return;
    }

    let cancelled = false;
    let index = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setPlaying(true);

    const step = () => {
      if (cancelled) return;
      const next = frames[index];
      if (!next) {
        setPlaying(false);
        return;
      }
      dispatch(next.frame);
      index += 1;
      setDelivered(index);
      const following = frames[index];
      if (!following) {
        setPlaying(false);
        return;
      }
      // Real gaps, scaled: a 94-second shell command would otherwise make the
      // playback useless, but the *shape* of the timing is what sells it.
      timer = setTimeout(step, Math.max(6, following.delayMs / speedRef.current));
    };

    timer = setTimeout(step, Math.max(6, (frames[0]?.delayMs ?? 200) / speedRef.current));

    return () => {
      cancelled = true;
      setPlaying(false);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [mode, token, taskId, runId, latestSeq, frames, history]);

  const restart = useCallback(() => setToken((t) => t + 1), []);

  return {
    state,
    mode,
    setMode,
    speed,
    setSpeed,
    delivered,
    total: frames.length,
    playing,
    restart,
  };
}
