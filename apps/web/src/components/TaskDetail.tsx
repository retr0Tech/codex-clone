"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { transcriptItems, isBackfilling, isTerminal } from "../lib/eventReducer";
import { useMockStream, type StreamMode } from "../lib/useMockStream";
import { historyForTask, playbackForTask, runsForTask } from "../mocks/runs";
import type { MockRepo, MockTask } from "../mocks/data";
import { StickToBottom } from "./StickToBottom";
import { Transcript } from "./transcript/Transcript";
import { DiffCard, DiffView } from "./diff/DiffView";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Segmented, Textarea } from "./ui/Field";
import { Spinner, EmptyState, DiffStat, Kbd } from "./ui/misc";
import { cn } from "./ui/cn";
import { formatDuration, shortSha } from "../lib/format";
import { STATUS_META } from "../lib/status";

type Tab = "transcript" | "diff";

export function TaskDetail({
  task,
  repo,
  initialMode,
}: {
  task: MockTask;
  repo: MockRepo;
  initialMode: StreamMode;
}) {
  const [tab, setTab] = useState<Tab>("transcript");
  const [followUp, setFollowUp] = useState("");

  const history = useMemo(() => historyForTask(task.id), [task.id]);
  const frames = useMemo(() => playbackForTask(task.id), [task.id]);
  const runs = useMemo(() => runsForTask(task.id), [task.id]);

  const stream = useMockStream({
    taskId: task.id,
    runId: runs[runs.length - 1]?.id ?? null,
    frames,
    history,
    initialMode,
  });

  const { state } = stream;
  const items = transcriptItems(state);
  const statusMeta = STATUS_META[state.status];
  const running = !isTerminal(state.status);
  const wallClock =
    history.length > 1
      ? Date.parse(history[history.length - 1]!.createdAt) - Date.parse(history[0]!.createdAt)
      : 0;

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
                <span className="text-fg-muted">{repo.fullName}</span>
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
                {running && stream.playing ? (
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

          {state.stopReason ? (
            <p className="mt-2 text-[12.5px] text-fg-muted">{state.stopReason}</p>
          ) : null}

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
            {running ? (
              <Button size="sm" variant="danger" disabled title="Cancel rides the same socket; wired up in milestone 10">
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* playback controls -- stands in for the live socket                */}
      {/* ---------------------------------------------------------------- */}
      <div className="shrink-0 border-b border-border bg-bg-sunken px-5 py-2 lg:px-8">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-fg-muted">
          <span className="flex items-center gap-1.5 font-medium text-fg-faint">
            <svg viewBox="0 0 12 12" className="size-3" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M1.5 6h2l1.2-3 2 6 1.3-3h2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Mock stream
          </span>
          <Segmented<StreamMode>
            size="sm"
            value={stream.mode}
            onChange={stream.setMode}
            label="Stream mode"
            options={[
              { value: "live", label: "Live", hint: "Replays the frame script on timers, deltas included" },
              { value: "history", label: "History", hint: "Folds only the durable rows, as a reload would" },
            ]}
          />
          {stream.mode === "live" ? (
            <>
              <Segmented<string>
                size="sm"
                value={String(stream.speed)}
                onChange={(v) => stream.setSpeed(Number(v))}
                label="Playback speed"
                options={[
                  { value: "1", label: "1×" },
                  { value: "4", label: "4×" },
                  { value: "16", label: "16×" },
                ]}
              />
              <Button size="sm" variant="ghost" onClick={stream.restart}>
                Restart
              </Button>
              <span className="font-mono text-[11px] tabular-nums text-fg-faint">
                {stream.delivered}/{stream.total} frames
              </span>
            </>
          ) : null}
          <span className="h-px flex-1" />
          <span className="font-mono text-[11px] tabular-nums text-fg-faint">
            seq {state.lastSeq}
            {isBackfilling(state) ? " · backfilling" : ""}
            {wallClock > 0 ? ` · ${formatDuration(wallClock)}` : ""}
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
        dep={stream.delivered}
        enabled={tab === "transcript"}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-6 lg:px-8"
      >
        <div className="mx-auto max-w-4xl pb-4">
          {tab === "transcript" ? (
            items.length === 0 ? (
              <EmptyState
                title={runs.length === 0 ? "No transcript for this task" : "Nothing on the wire yet"}
                body={
                  runs.length === 0
                    ? "This task has no run in the fixture set. Once the worker exists, its event log would be backfilled here from seq 0."
                    : "The run has been claimed but has not emitted its first event. Live frames appear here as they arrive."
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
              body="The host derives the diff with git diff against the base SHA after each turn. This run never produced one — it stopped before reaching that point."
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
              <div className="flex items-center gap-2">
                {task.additions + task.deletions > 0 ? (
                  <DiffStat additions={task.additions} deletions={task.deletions} />
                ) : null}
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
          <p className="mt-2 text-[11.5px] text-fg-faint">
            No backend is wired up yet.{" "}
            <Link href="/mock/transcript" className="text-accent hover:underline">
              Play another fixture
            </Link>{" "}
            to see the streaming states.
          </p>
        </div>
      </footer>
    </div>
  );
}
