"use client";

import { useEffect, useState } from "react";
import type { TaskView } from "./types";

/**
 * The task list, polled.
 *
 * Deliberately NOT on the WebSocket. The hub is per-task -- it exists to stream
 * one transcript -- and turning it into a general-purpose change feed would
 * mean every tab subscribing to every task's events just to notice that a badge
 * changed colour. A five-second poll of a local endpoint costs nothing and has
 * no reconnect semantics to get wrong.
 *
 * The task PAGE is the live view; this is the ambient one.
 */
export const TASK_POLL_MS = 5_000;

export function useTasks(pollMs = TASK_POLL_MS): { tasks: TaskView[]; loading: boolean } {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        // `archived=1`: the sidebar shows a COUNT of archived tasks next to the
        // link, and filters them out of the per-repo list itself. Without this
        // the endpoint never returns one and that count is permanently zero.
        const response = await fetch("/api/tasks?archived=1", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as { tasks?: TaskView[] };
        if (!controller.signal.aborted) setTasks(body.tasks ?? []);
      } catch {
        // A poll that failed is a poll; the next one is five seconds away.
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
  }, [pollMs]);

  return { tasks, loading };
}
