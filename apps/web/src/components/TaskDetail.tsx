"use client";

import { useCallback, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { isTerminal, transcriptItems } from "../lib/eventReducer";
import { useTranscriptStream, type ConnectionState } from "../lib/useTranscriptStream";
import type { RunView, TaskView } from "../lib/types";
import { StickToBottom } from "./StickToBottom";
import { ArchiveActions } from "./archive/ArchiveActions";
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
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("transcript");
  const [followUp, setFollowUp] = useState("");
  const [sending, setSending] = useState(false);
  const [publishing, setPublishing] = useState<null | "push" | "pr">(null);
  const [publish, setPublish] = useState<PublishState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const stream = useTranscriptStream({ taskId: task.id, wsUrl });
  const { state } = stream;
  const items = transcriptItems(state);

  const latestRun = runs[runs.length - 1] ?? task.latestRun;
  // The transcript wins once it has said anything: it is the live truth, and
  // the row was read before the page was sent.
  const status = state.events.length > 0 ? state.status : (latestRun?.status ?? "queued");
  const statusMeta = STATUS_META[status];
  const running = !isTerminal(status);
  // An archived task is not claimable (see claim.ts), so a follow-up would sit
  // queued forever. Say so rather than letting the composer take one.
  const archived = task.status === "archived";
  const stopReason = state.stopReason ?? latestRun?.stopReason ?? null;
  const runId = state.runId ?? latestRun?.id ?? null;

  const wallClock =
    state.events.length > 1
      ? Date.parse(state.events[state.events.length - 1]!.createdAt) - Date.parse(state.events[0]!.createdAt)
      : 0;

  const spent = runs.reduce((total, run) => total + run.costUsd, 0);

  /**
   * A follow-up is a NEW run against the same warm workspace, not a mutation of
   * the last one. The transcript stays append-only, its events continue in the
   * same seq space, and the socket is already subscribed -- so the new run's
   * first frame simply arrives. `router.refresh()` re-reads the server metadata
   * (run count, branch) without touching the stream.
   */
  const sendFollowUp = useCallback(async () => {
    const prompt = followUp.trim();
    if (prompt === "" || sending || running) return;
    setSending(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const body = (await response.json()) as { runId?: string; error?: string };
      if (!response.ok) {
        setActionError(body.error ?? `the follow-up failed with ${response.status}`);
        return;
      }
      setFollowUp("");
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }, [followUp, sending, running, task.id, router]);

  /**
   * Push, and optionally open a pull request. Both are host-side: the branch is
   * committed and pushed from the worker with the stored PAT, and the container
   * that produced the work never had a credential to do it itself.
   */
  const runPublish = useCallback(
    async (openPullRequest: boolean) => {
      if (publishing || running) return;
      setPublishing(openPullRequest ? "pr" : "push");
      setActionError(null);
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/publish`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ openPullRequest }),
        });
        const body = (await response.json()) as PublishState & { error?: string };
        if (!response.ok) {
          setActionError(body.error ?? `publishing failed with ${response.status}`);
          return;
        }
        setPublish(body);
        router.refresh();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setPublishing(null);
      }
    },
    [publishing, running, task.id, router],
  );

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void sendFollowUp();
    }
  }

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
          {actionError ? (
            <p className="mt-2 rounded-md border border-danger/40 bg-danger-soft px-2.5 py-1.5 text-[12px] text-danger">
              {actionError}
            </p>
          ) : null}
          {notice ? (
            <p className="mt-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[12px] text-fg-muted">
              {notice}
            </p>
          ) : null}
          {publish ? <PublishBanner publish={publish} /> : null}

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

            <Button
              size="sm"
              variant="secondary"
              onClick={() => void runPublish(false)}
              disabled={publishing !== null || running || !task.workBranch}
              title={
                running
                  ? "Wait for the run to finish: committing rewrites .git in the workspace volume"
                  : !task.workBranch
                    ? "Run the task once first — there is no workspace to push yet"
                    : "Commits the workspace and pushes the branch from the host, using the stored PAT"
              }
            >
              {publishing === "push" ? "Pushing…" : "Push branch"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void runPublish(true)}
              disabled={publishing !== null || running || !task.workBranch}
              title="Pushes the branch, then opens a pull request against the base branch"
            >
              {publishing === "pr" ? "Opening…" : "Open PR"}
            </Button>
            {/* Milestone 8. Archiving is a status change, not a deletion: the
                transcript is kept and the workspace moves to the cold tier. */}
            <ArchiveActions task={task} running={running} onNotice={setNotice} onError={setActionError} />
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
              onKeyDown={onComposerKeyDown}
              placeholder={
                archived
                  ? "This task is archived. Restore it to send another turn."
                  : running
                    ? "A run is in flight. The follow-up queues behind it."
                    : task.mode === "ask"
                      ? "Ask a follow-up. Ask mode mounts the workspace read-only."
                      : "Send a follow-up turn. It reuses this task's warm workspace."
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
                onClick={() => void sendFollowUp()}
                disabled={followUp.trim().length === 0 || sending || running || archived}
                title={
                  archived
                    ? "Archived tasks are not claimable. Restore it first; the workspace comes back from its cold snapshot."
                    : running
                      ? "This task already has a run in flight; one run per task at a time"
                      : "Queues a new run against the same workspace, continuing this task"
                }
                className={cn(followUp.trim().length === 0 && "opacity-45")}
              >
                {sending ? "Queueing…" : "Send"}
              </Button>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

interface PublishState {
  branch: string;
  commit: string | null;
  filesChanged: number;
  branchUrl: string;
  compareUrl: string;
  pullRequest: { number: number; url: string; created: boolean } | null;
}

/**
 * Where the work ended up.
 *
 * The whole point of the slice is a branch you can open as a pull request, so
 * the URLs are the result -- not a toast that disappears.
 */
function PublishBanner({ publish }: { publish: PublishState }) {
  return (
    <div className="mt-2 rounded-md border border-ok/40 bg-ok-soft px-2.5 py-2 text-[12px] text-ok">
      <p>
        Pushed <span className="font-mono">{publish.branch}</span>
        {publish.commit ? <span className="font-mono"> @ {shortSha(publish.commit)}</span> : null} ·{" "}
        {publish.filesChanged} file{publish.filesChanged === 1 ? "" : "s"}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <a className="underline underline-offset-2" href={publish.branchUrl} target="_blank" rel="noreferrer">
          View branch
        </a>
        {publish.pullRequest ? (
          <a className="underline underline-offset-2" href={publish.pullRequest.url} target="_blank" rel="noreferrer">
            {publish.pullRequest.created ? "Pull request" : "Existing pull request"} #{publish.pullRequest.number}
          </a>
        ) : (
          <a className="underline underline-offset-2" href={publish.compareUrl} target="_blank" rel="noreferrer">
            Open a pull request on GitHub
          </a>
        )}
      </p>
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
