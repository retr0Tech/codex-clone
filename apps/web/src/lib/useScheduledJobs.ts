"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ScheduledJobView } from "./scheduled";

/**
 * The scheduled-job list, polled.
 *
 * The same shape as `useTasks`, and polled for the same reason: the WebSocket
 * hub is per-task and exists to stream one transcript, so noticing that an
 * execution finished is not something it should be asked to do.
 *
 * The interval matters more here than it does for tasks, though. The worker's
 * tick is thirty seconds, so an occurrence can fire, run and be settled between
 * two slow polls; five seconds keeps "it is running now" visible rather than
 * something you only ever see the aftermath of.
 */
export const SCHEDULE_POLL_MS = 5_000;

export interface ScheduledJobsState {
  jobs: ScheduledJobView[];
  loading: boolean;
  /** Non-null when the list could not be loaded at all. */
  error: string | null;
  /** Re-reads immediately; used after a mutation rather than waiting a tick. */
  refresh: () => void;
}

export function useScheduledJobs(initial: ScheduledJobView[] = [], pollMs = SCHEDULE_POLL_MS): ScheduledJobsState {
  const [jobs, setJobs] = useState<ScheduledJobView[]>(initial);
  const [loading, setLoading] = useState(initial.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Held in a ref so `refresh` never changes identity and cannot re-trigger the
  // effect that owns the poll.
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    pending.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        const response = await fetch("/api/scheduled-jobs", { signal: controller.signal, cache: "no-store" });
        const body = (await response.json()) as { jobs?: ScheduledJobView[]; error?: string };
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setError(body.error ?? `the schedule list failed with ${response.status}`);
          return;
        }
        setError(null);
        setJobs(body.jobs ?? []);
      } catch {
        // A poll that failed is a poll; the next one is seconds away. Only a
        // response the server actually rejected is worth showing.
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          // Scheduled after completion rather than on an interval, so a slow
          // response cannot stack requests on top of each other.
          timer = setTimeout(() => void load(), pollMs);
        }
      }
    };

    void load();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [pollMs, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { jobs, loading, error, refresh };
}
