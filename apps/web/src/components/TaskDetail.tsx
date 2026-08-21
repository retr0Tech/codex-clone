"use client";

import { useState } from "react";
import { isTerminal, transcriptItems } from "../lib/eventReducer";
import { useTranscriptStream, type ConnectionState } from "../lib/useTranscriptStream";
import type { RunView, TaskView } from "../lib/types";
import { StickToBottom } from "./StickToBottom";
import { Transcript } from "./transcript/Transcript";
import { DiffCard, DiffView } from "./diff/DiffView";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Segmented, Textarea } from "./ui/Field";
import { Spinner, EmptyState, Kbd } from "./ui/misc";
import { cn } from "./ui/cn";
import { formatDuration, shortSha } from "../lib/format";
import { STATUS_META } from "../lib/status";

type Tab = "transcript" | "diff";

/**
 * One task, live.
 *
 * Everything below the header is folded by `transcriptReducer` -- the same
 * reducer, the same frames, whether they arrived from the history endpoint on
 * page load or from the socket a millisecond ago. There is no second rendering
 * path for "replayed" content, which is why a reload cannot show something the
 * live view could not (PLAN.md §3.6).
 *
 * The server-rendered `task` and `runs` are metadata only: repo, branch, pinned
 * SHA, cost so far. The moment the stream produces a status it takes over,
 * because the stream is ahead of anything a page render could have read.
 */
export function TaskDetail({ task, runs, wsUrl }: { task: TaskView; runs: RunView[]; wsUrl: string }) {
  const [tab, setTab] = useState<Tab>("transcript");
  const [followUp, setFollowUp] = useState("");

  const stream = useTranscriptStream({ taskId: task.id, wsUrl });
  const { state } = stream;
  const items = transcriptItems(state);

  const latestRun = runs[runs.length - 1] ?? task.latestRun;
  // The transcript wins once it has said anything: it is the live truth, and
  // the row was read before the page was sent.
  const status = state.events.length > 0 ? state.status : (latestRun?.status ?? "queued");
  const statusMeta = STATUS_META[status];
  const running = !isTerminal(status);
  const stopReason = state.stopReason ?? latestRun?.stopReason ?? null;
  const runId = state.runId ?? latestRun?.id ?? null;

  const wallClock =
    state.events.length > 1
      ? Date.parse(state.events[state.events.length - 1]!.createdAt) - Date.parse(state.events[0]!.createdAt)
      : 0;

  const spent = runs.reduce((total, run) => total + run.costUsd, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ---------------------------------------------------------------- */}
      {/* header                                                            */}
      {/* ---------------------------------------------------------------- */}
      <header className="shrink-0 border-b border-border bg-bg px-5 py-3.5 lg:px-8">
        <div className="mx-auto max-w-4xl">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="min-w-0">
              <h1 className="truncate text-[16px] font-semibold tracking-tight">{task.title}</h1>
              <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11.5px] text-fg-faint">
                <span className="text-fg-muted">{task.repoFullName}</span>
                <span aria-hidden>·</span>
                <span>{task.baseBranch}</span>
                <span aria-hidden>·</span>
                <span title={task.baseSha}>base {shortSha(task.baseSha)}</span>
                {task.workBranch ? (
                  <>
                    <span aria-hidden>·</span>
                    <span className="text-accent">{task.workBranch}</span>
                  </>
                ) : null}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={task.mode === "ask" ? "neutral" : "accent"}>
                {task.mode === "ask" ? "Ask" : "Code"}
              </Badge>
              <Badge tone={statusMeta.tone} dot>
                {running ? (
                  <span className="flex items-center gap-1.5">
                    <Spinner className="size-3" />
                    {statusMeta.label}
                  </span>
                ) : (
                  statusMeta.label
                )}
              </Badge>
            </div>
          </div>

          {stopReason ? <p className="mt-2 text-[12.5px] text-fg-muted">{stopReason}</p> : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Segmented<Tab>
              value={tab}
              onChange={setTab}
              label="View"
              options={[
                { value: "transcript", label: "Transcript" },
                {
                  value: "diff",
                  label: (
                    <span className="flex items-center gap-1.5">
                      Diff
                      {state.latestDiff ? (
                        <span className="font-mono text-[11px] text-fg-faint">{state.latestDiff.files.length}</span>
                      ) : null}
                    </span>
                  ),
                },
              ]}
            />

            <span className="h-px flex-1" />

            <Button size="sm" variant="secondary" disabled title="Wired up in milestone 7">
              Push branch
            </Button>
            <Button size="sm" variant="secondary" disabled title="Wired up in milestone 7">
              Open PR
            </Button>
            {running && runId ? (
              <Button
                size="sm"
                variant="danger"
                onClick={() => stream.cancel(runId)}
                disabled={stream.connection !== "live"}
                title={
                  stream.connection === "live"
                    ? "Closes the gateway meter, then SIGTERM with a grace period. Partial work is kept."
                    : "Cancel rides the socket; reconnecting…"
                }
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* connection strip                                                  */}
      {/* ---------------------------------------------------------------- */}
      <div className="shrink-0 border-b border-border bg-bg-sunken px-5 py-2 lg:px-8">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-fg-muted">
          <ConnectionPill connection={stream.connection} backfilling={stream.backfilling} />
          {stream.error ? (
            <span className="text-[11.5px] text-warn">history unavailable: {stream.error}</span>
          ) : null}
          <span className="h-px flex-1" />
          <span className="font-mono text-[11px] tabular-nums text-fg-faint">
            {runs.length > 0 ? `${runs.length} run${runs.length === 1 ? "" : "s"} · ` : ""}
            seq {state.lastSeq}
            {wallClock > 0 ? ` · ${formatDuration(wallClock)}` : ""}
            {spent > 0 ? ` · $${spent.toFixed(4)}` : ""}
          </span>
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* body                                                              */}
      {/* ---------------------------------------------------------------- */}
      {/* Keyed on the tab so switching panes starts at the top of the new one
          rather than inheriting the other's scroll offset. */}
      <StickToBottom
        key={tab}
        dep={items.length}
        enabled={tab === "transcript"}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-6 lg:px-8"
      >
        <div className="mx-auto max-w-4xl pb-4">
          {tab === "transcript" ? (
            items.length === 0 ? (
              <EmptyState
                title={running ? "Nothing on the wire yet" : "No transcript for this task"}
                body={
                  running
                    ? "The run is queued behind the worker's concurrency limit, or the container has not emitted its first event. Frames appear here as they arrive."
                    : "This task produced no events. If the worker was not running when it was created, start it and the queued run will be claimed."
                }
              />
            ) : (
              <Transcript items={items} renderDiff={(diff) => <DiffCard diff={diff} />} />
            )
          ) : state.latestDiff ? (
            <DiffView diff={state.latestDiff} />
          ) : (
            <EmptyState
              title="No diff for this run"
              body="The host derives the diff with git diff against the base SHA after each turn. This run has not produced one yet."
              action={
                <Button size="sm" onClick={() => setTab("transcript")}>
                  Back to transcript
                </Button>
              }
            />
          )}
        </div>
      </StickToBottom>

      {/* ---------------------------------------------------------------- */}
      {/* follow-up composer                                                */}
      {/* ---------------------------------------------------------------- */}
      <footer className="shrink-0 border-t border-border bg-bg px-5 py-3 lg:px-8">
        <div className="mx-auto max-w-4xl">
          <div className="rounded-xl border border-border-strong bg-surface p-2 focus-within:border-fg-faint">
            <Textarea
              rows={2}
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              placeholder={
                task.mode === "ask"
                  ? "Ask a follow-up. Ask mode mounts the workspace read-only."
                  : "Send a follow-up turn. The container stays warm for 15 minutes."
              }
              className="border-0 bg-transparent px-1.5 py-1 focus-visible:outline-none"
            />
            <div className="flex items-center justify-between gap-3 px-1.5 pt-1">
              <p className="flex items-center gap-1.5 text-[11.5px] text-fg-faint">
                <Kbd>⌘</Kbd>
                <Kbd>↵</Kbd>
                to send
              </p>
              <Button
                size="sm"
                variant="primary"
                disabled
                title="Follow-up turns land in milestone 7"
                className={cn(followUp.trim().length === 0 && "opacity-45")}
              >
                Send
              </Button>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

/**
 * Says which of the three states the socket is in, and whether the client is
 * still catching up on the server's backlog. Worth surfacing: "live" and
 * "reconnecting, showing you history" look identical otherwise, and only one of
 * them means what you are reading is current.
 */
function ConnectionPill({ connection, backfilling }: { connection: ConnectionState; backfilling: boolean }) {
  const meta: Record<ConnectionState, { label: string; tone: "ok" | "warn" | "neutral" }> = {
    connecting: { label: "Connecting", tone: "neutral" },
    live: { label: backfilling ? "Catching up" : "Live", tone: backfilling ? "neutral" : "ok" },
    reconnecting: { label: "Reconnecting", tone: "warn" },
  };
  const { label, tone } = meta[connection];

  return (
    <span className="flex items-center gap-1.5">
      <Badge tone={tone} dot>
        {label}
      </Badge>
      <span className="text-[11.5px] text-fg-faint">
        {connection === "live" && !backfilling
          ? "frames stream from the worker; token deltas are overlay only"
          : "showing what has been persisted so far"}
      </span>
    </span>
  );
}
