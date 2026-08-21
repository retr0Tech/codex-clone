"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { mockRuns } from "../../../mocks/runs";
import { taskById } from "../../../mocks/data";
import { useMockStream, type StreamMode } from "../../../lib/useMockStream";
import { isBackfilling, transcriptItems } from "../../../lib/eventReducer";
import { StickToBottom } from "../../../components/StickToBottom";
import { Transcript } from "../../../components/transcript/Transcript";
import { DiffCard } from "../../../components/diff/DiffView";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { Segmented } from "../../../components/ui/Field";
import { Spinner } from "../../../components/ui/misc";
import { cn } from "../../../components/ui/cn";
import { STATUS_META } from "../../../lib/status";

/**
 * Dev-only harness. Plays a fixture back at something like real timing so the
 * streaming states — token deltas arriving, a tool card sitting on "running",
 * a run winding down with a reason — can actually be looked at before any
 * backend exists.
 *
 * It shares `useMockStream` with the task view on purpose: if the harness and
 * the real view diverged, the harness would stop being evidence of anything.
 */
export default function MockTranscriptPage() {
  const [runId, setRunId] = useState(mockRuns[0]!.id);
  const run = useMemo(() => mockRuns.find((r) => r.id === runId) ?? mockRuns[0]!, [runId]);

  const stream = useMockStream({
    taskId: run.taskId,
    runId: run.id,
    frames: run.frames,
    history: run.events,
    initialMode: "live",
  });

  const { state } = stream;
  const items = transcriptItems(state);
  const meta = STATUS_META[state.status];
  const task = taskById(run.taskId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border px-5 py-3.5 lg:px-8">
        <div className="mx-auto max-w-5xl">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-[16px] font-semibold tracking-tight">Fixture playback</h1>
              <p className="mt-0.5 text-[12.5px] text-fg-muted">
                Same reducer, same frames the WebSocket will carry. Nothing here talks to a server.
              </p>
            </div>
            {task ? (
              <Link
                href={`/tasks/${task.id}`}
                className="text-[12.5px] text-accent hover:underline"
              >
                Open the task view →
              </Link>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {mockRuns.map((r) => {
              const active = r.id === run.id;
              const rMeta = STATUS_META[r.status];
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRunId(r.id)}
                  aria-pressed={active}
                  title={r.blurb}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12.5px] transition-colors",
                    active
                      ? "border-accent bg-accent-soft text-fg"
                      : "border-border bg-surface text-fg-muted hover:bg-surface-2 hover:text-fg",
                  )}
                >
                  <span className="font-medium">{r.label}</span>
                  <Badge tone={rMeta.tone} dot>
                    {r.status}
                  </Badge>
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <div className="shrink-0 border-b border-border bg-bg-sunken px-5 py-2 lg:px-8">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-fg-muted">
          <Segmented<StreamMode>
            size="sm"
            value={stream.mode}
            onChange={stream.setMode}
            label="Stream mode"
            options={[
              { value: "live", label: "Live", hint: "Frame script on timers, token deltas included" },
              { value: "history", label: "History", hint: "Durable rows only, as a reload would fold them" },
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
            </>
          ) : null}
          <span className="flex items-center gap-1.5">
            {stream.playing ? <Spinner className="size-3 text-accent" /> : null}
            <span className="font-mono text-[11px] tabular-nums text-fg-faint">
              {stream.delivered}/{stream.total} frames · seq {state.lastSeq}
              {isBackfilling(state) ? " · backfilling" : ""}
            </span>
          </span>
          <span className="h-px flex-1" />
          <Badge tone={meta.tone} dot>
            {meta.label}
          </Badge>
        </div>
      </div>

      <StickToBottom dep={stream.delivered} className="min-h-0 flex-1 overflow-y-auto px-5 py-6 lg:px-8">
        <div className="mx-auto max-w-5xl">
          <p className="mb-5 rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 text-[12.5px] text-fg-muted">
            <span className="font-medium text-fg">{run.label}.</span> {run.blurb}
            <span className="mt-1 block font-mono text-[11.5px] text-fg-faint">
              prompt: {run.prompt}
            </span>
          </p>
          <Transcript items={items} renderDiff={(diff) => <DiffCard diff={diff} />} />
          <div className="h-16" />
        </div>
      </StickToBottom>
    </div>
  );
}
