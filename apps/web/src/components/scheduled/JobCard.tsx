"use client";

import Link from "next/link";
import { useState } from "react";
import type { ScheduledExecutionStatus, ScheduledJobView } from "../../lib/scheduled";
import { formatDateTime } from "../../lib/format";
import { RelativeTime } from "../RelativeTime";
import { Badge, type Tone } from "../ui/Badge";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { ScheduleForm, draftFrom, type ScheduleDraft } from "./ScheduleForm";

/**
 * One schedule, and the last few things it did.
 *
 * The execution list is the part worth arguing for. A schedule you can only see
 * the NEXT run of tells you nothing about whether it has been working, so every
 * occurrence is shown -- including the ones that were deliberately skipped,
 * with the reason they were skipped. "Skipped: the previous execution was still
 * running" and "this job has been silently broken for a week" look identical
 * otherwise, and only one of them is fine.
 */

const EXECUTION_TONE: Record<ScheduledExecutionStatus, Tone> = {
  succeeded: "ok",
  failed: "danger",
  skipped: "warn",
  running: "info",
  claimed: "neutral",
};

export interface JobActions {
  onSave: (id: string, draft: ScheduleDraft) => Promise<boolean>;
  onToggle: (id: string, enabled: boolean) => void;
  onRunNow: (id: string) => void;
  onDelete: (id: string) => void;
  /** Ids with a request in flight, so their buttons stop rather than stack. */
  busy: Set<string>;
  /** Per-job message from the last action, success or failure. */
  notice: { id: string; text: string; ok: boolean } | null;
}

export function JobCard({ job, actions }: { job: ScheduledJobView; actions: JobActions }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ScheduleDraft>(() => draftFrom(job));
  const [saveError, setSaveError] = useState<string | null>(null);
  const busy = actions.busy.has(job.id);
  const notice = actions.notice?.id === job.id ? actions.notice : null;

  const startEditing = () => {
    setDraft(draftFrom(job));
    setSaveError(null);
    setEditing(true);
  };

  return (
    <article className={cn("rounded-xl border border-border bg-surface", !job.enabled && "opacity-70")}>
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-medium">{job.name}</h3>
            {job.enabled ? (
              <Badge tone="ok" dot>
                Enabled
              </Badge>
            ) : (
              <Badge tone="neutral">Paused</Badge>
            )}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2.5 font-mono text-[11.5px] text-fg-faint">
            <span className="text-fg-muted">{job.repoFullName}</span>
            <span aria-hidden>·</span>
            <span>{job.baseBranch}</span>
            <span aria-hidden>·</span>
            <span>{job.cronExpr}</span>
            <span aria-hidden>·</span>
            <span>{job.timezone}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => actions.onRunNow(job.id)}>
            Run now
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => (editing ? setEditing(false) : startEditing())}>
            {editing ? "Close" : "Edit"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => actions.onToggle(job.id, !job.enabled)}
            title={job.enabled ? "Stop claiming occurrences of this job" : "Resume from the next occurrence, not the missed one"}
          >
            {job.enabled ? "Pause" : "Resume"}
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => actions.onDelete(job.id)}>
            Delete
          </Button>
        </div>
      </header>

      <div className="px-4 py-3">
        {notice ? (
          <p
            className={cn(
              "mb-3 rounded-md border px-2.5 py-1.5 text-[12px]",
              notice.ok ? "border-ok/40 bg-ok-soft text-ok" : "border-danger/40 bg-danger-soft text-danger",
            )}
          >
            {notice.text}
          </p>
        ) : null}

        {editing ? (
          <ScheduleForm
            draft={draft}
            onChange={setDraft}
            onSubmit={() => {
              setSaveError(null);
              void actions.onSave(job.id, draft).then((ok) => {
                if (ok) setEditing(false);
                else setSaveError("the schedule could not be saved; see the message above");
              });
            }}
            onCancel={() => setEditing(false)}
            submitLabel="Save changes"
            busy={busy}
            error={saveError}
            lockRepo
          />
        ) : (
          <>
            <p className="whitespace-pre-wrap text-[13px] text-fg-muted">{job.prompt}</p>

            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-[12.5px] sm:grid-cols-4">
              <Fact label="Cadence">{job.cronHuman ?? <span className="font-mono text-[11.5px]">{job.cronExpr}</span>}</Fact>
              <Fact label="Next run">
                {job.enabled ? (
                  <span className="font-mono text-[11.5px]">{formatDateTime(job.nextRunAt)}</span>
                ) : (
                  <span className="text-fg-faint">paused</span>
                )}
              </Fact>
              <Fact label="Last run">
                {job.lastRunAt ? (
                  <RelativeTime iso={job.lastRunAt} className="text-[12.5px]" />
                ) : (
                  <span className="text-fg-faint">never</span>
                )}
              </Fact>
              <Fact label="Result">
                {job.autoOpenPr ? "Push branch + open PR" : job.autoPushBranch ? "Push branch" : "Keep in workspace"}
              </Fact>
              <Fact label="On overlap">
                {job.onOverlap === "skip" ? "Skip, and record it" : "Queue behind the running one"}
              </Fact>
              <Fact label="After downtime">{job.catchup ? "Fire once on recovery" : "Record the misses as skipped"}</Fact>
            </dl>
          </>
        )}

        <div className="mt-4">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-faint">
            Recent executions
          </p>
          {job.recent.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[12.5px] text-fg-faint">
              Nothing yet. The worker claims this job when{" "}
              <span className="font-mono">{formatDateTime(job.nextRunAt)}</span> comes round.
            </p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {job.recent.map((execution) => (
                <li
                  key={execution.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-surface-2 px-3 py-2"
                >
                  <Badge tone={EXECUTION_TONE[execution.status]} dot>
                    {execution.status}
                  </Badge>
                  <span className="font-mono text-[11.5px] text-fg-faint">
                    {formatDateTime(execution.scheduledFor)}
                  </span>
                  {execution.reason ? (
                    <span className="min-w-0 flex-1 text-[12px] text-fg-muted">{execution.reason}</span>
                  ) : (
                    <span className="h-px flex-1" />
                  )}
                  {execution.taskId ? (
                    <Link
                      href={`/tasks/${execution.taskId}`}
                      className="text-[12px] text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                    >
                      transcript
                    </Link>
                  ) : null}
                  <RelativeTime iso={execution.scheduledFor} className="text-[11.5px] text-fg-faint" />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </article>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-[0.07em] text-fg-faint">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
