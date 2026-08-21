"use client";

import { useCallback, useState } from "react";
import type { ScheduledJobView } from "../../lib/scheduled";
import { useScheduledJobs } from "../../lib/useScheduledJobs";
import { useWorkspace } from "../WorkspaceContext";
import { Button } from "../ui/Button";
import { EmptyState, SectionHeading, Spinner } from "../ui/misc";
import { JobCard, type JobActions } from "./JobCard";
import { ScheduleForm, emptyDraft, type ScheduleDraft } from "./ScheduleForm";

/**
 * The `/scheduled` page's interactive half.
 *
 * Server-rendered rows arrive as `initialJobs` so the list is right on first
 * paint; from there it polls, because an occurrence can fire, run and settle
 * between two page loads and a schedule you have to refresh to believe is not
 * much of a schedule.
 *
 * Every mutation is a plain REST call followed by an immediate refresh rather
 * than a local edit of the array. That is deliberate: `next_run_at` is
 * recomputed server-side on several of these -- re-enabling a paused job moves
 * it, editing the cron expression moves it -- and optimistically guessing the
 * new value in the browser would mean showing a time the worker does not agree
 * with.
 */

interface Notice {
  id: string;
  text: string;
  ok: boolean;
}

export function ScheduleManager({ initialJobs }: { initialJobs: ScheduledJobView[] }) {
  const { repo } = useWorkspace();
  const { jobs, loading, error, refresh } = useScheduledJobs(initialJobs);

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<ScheduleDraft>(() => emptyDraft("", ""));
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<Notice | null>(null);

  const withBusy = useCallback(async (id: string, work: () => Promise<Notice | null>) => {
    setBusy((current) => new Set(current).add(id));
    try {
      const result = await work();
      setNotice(result);
      refresh();
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }, [refresh]);

  const openCreate = () => {
    setDraft(emptyDraft(repo?.fullName ?? "", repo?.defaultBranch ?? ""));
    setCreateError(null);
    setCreating(true);
  };

  const create = async () => {
    setCreateError(null);
    setBusy((current) => new Set(current).add("new"));
    try {
      const response = await fetch("/api/scheduled-jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = (await response.json()) as { job?: ScheduledJobView; error?: string };
      if (!response.ok || !body.job) {
        setCreateError(body.error ?? `creating the schedule failed with ${response.status}`);
        return;
      }
      setCreating(false);
      refresh();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete("new");
        return next;
      });
    }
  };

  const actions: JobActions = {
    busy,
    notice,
    onSave: async (id, next) => {
      let ok = false;
      await withBusy(id, async () => {
        const response = await fetch(`/api/scheduled-jobs/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: next.name,
            baseBranch: next.baseBranch,
            prompt: next.prompt,
            cronExpr: next.cronExpr,
            timezone: next.timezone,
            onOverlap: next.onOverlap,
            catchup: next.catchup,
            autoPushBranch: next.autoPushBranch,
            autoOpenPr: next.autoOpenPr,
          }),
        });
        const body = (await response.json()) as { job?: ScheduledJobView; error?: string };
        ok = response.ok && body.job !== undefined;
        return ok ? null : { id, text: body.error ?? `saving failed with ${response.status}`, ok: false };
      });
      return ok;
    },
    onToggle: (id, enabled) => {
      void withBusy(id, async () => {
        const response = await fetch(`/api/scheduled-jobs/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        if (response.ok) return null;
        const body = (await response.json()) as { error?: string };
        return { id, text: body.error ?? `could not ${enabled ? "resume" : "pause"} this job`, ok: false };
      });
    },
    onRunNow: (id) => {
      void withBusy(id, async () => {
        const response = await fetch(`/api/scheduled-jobs/${id}/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        const body = (await response.json()) as { taskId?: string; workBranch?: string; error?: string };
        if (!response.ok || !body.taskId) {
          return { id, text: body.error ?? `run now failed with ${response.status}`, ok: false };
        }
        // Not a redirect: a schedule you pressed by hand is still a schedule,
        // and the row it just added is right below the button.
        return { id, text: `Queued on ${body.workBranch ?? "a new branch"}.`, ok: true };
      });
    },
    onDelete: (id) => {
      const job = jobs.find((j) => j.id === id);
      if (typeof window !== "undefined") {
        const confirmed = window.confirm(
          `Delete "${job?.name ?? id}"?\n\nThe tasks it already created are kept — their transcripts, diffs and pushed branches are real work. Only the schedule and its history of occurrences go.`,
        );
        if (!confirmed) return;
      }
      void withBusy(id, async () => {
        const response = await fetch(`/api/scheduled-jobs/${id}`, { method: "DELETE" });
        if (response.ok) return null;
        const body = (await response.json()) as { error?: string };
        return { id, text: body.error ?? `deleting failed with ${response.status}`, ok: false };
      });
    },
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Scheduled</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-fg-muted">
            Jobs are claimed from Postgres with <code className="font-mono text-[12px]">FOR UPDATE SKIP LOCKED</code>,
            so they survive a restart and cannot double-fire across workers. Every execution gets a brand-new workspace,
            and skipped occurrences are recorded rather than dropped — a schedule that silently did nothing is
            indistinguishable from one that is broken.
          </p>
        </div>
        {creating ? null : (
          <Button variant="primary" onClick={openCreate}>
            New schedule
          </Button>
        )}
      </div>

      {creating ? (
        <ScheduleForm
          draft={draft}
          onChange={setDraft}
          onSubmit={() => void create()}
          onCancel={() => setCreating(false)}
          submitLabel="Create schedule"
          busy={busy.has("new")}
          error={createError}
        />
      ) : null}

      {error ? (
        <p className="rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-[13px] text-danger">{error}</p>
      ) : null}

      <section>
        <SectionHeading
          aside={
            <span className="flex items-center gap-2 text-[11.5px] text-fg-faint">
              {loading ? <Spinner /> : null}
              Tick interval 30s
            </span>
          }
        >
          {jobs.length} {jobs.length === 1 ? "job" : "jobs"}
        </SectionHeading>

        {jobs.length === 0 ? (
          <EmptyState
            title="No schedules yet"
            body="A scheduled job runs a prompt against a branch on a cron cadence, in a fresh container each time, and pushes what it produced. Nightly dependency audits and weekly changelog drafts are the obvious ones."
            action={
              creating ? null : (
                <Button variant="primary" onClick={openCreate}>
                  New schedule
                </Button>
              )
            }
          />
        ) : (
          <div className="space-y-4">
            {jobs.map((job) => (
              <JobCard key={job.id} job={job} actions={actions} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
