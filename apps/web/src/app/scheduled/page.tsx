import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { SectionHeading } from "../../components/ui/misc";
import { RelativeTime } from "../../components/RelativeTime";
import { repoById, mockScheduledJobs, type MockScheduledJob } from "../../mocks/data";
import { formatDateTime } from "../../lib/format";
import { cn } from "../../components/ui/cn";

export const metadata = { title: "Scheduled · codex-clone" };

const EXECUTION_TONE = {
  succeeded: "ok",
  failed: "danger",
  skipped: "warn",
  running: "info",
  claimed: "neutral",
} as const;

function JobCard({ job }: { job: MockScheduledJob }) {
  const repo = repoById(job.repoId);
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
            <span className="text-fg-muted">{repo?.fullName}</span>
            <span aria-hidden>·</span>
            <span>{job.cronExpr}</span>
            <span aria-hidden>·</span>
            <span>{job.timezone}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" disabled title="Scheduler lands in milestone 9">
            Run now
          </Button>
          <Button size="sm" variant="ghost" disabled title="Scheduler lands in milestone 9">
            Edit
          </Button>
        </div>
      </header>

      <div className="px-4 py-3">
        <p className="text-[13px] text-fg-muted">{job.prompt}</p>

        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-[12.5px] sm:grid-cols-4">
          <div>
            <dt className="text-[11px] uppercase tracking-[0.07em] text-fg-faint">Cadence</dt>
            <dd className="mt-0.5">{job.cronHuman}</dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-[0.07em] text-fg-faint">Next run</dt>
            <dd className="mt-0.5 font-mono text-[11.5px]">{formatDateTime(job.nextRunAt)}</dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-[0.07em] text-fg-faint">On overlap</dt>
            <dd className="mt-0.5">
              {job.onOverlap === "skip" ? "Skip, and record it" : "Queue behind the running one"}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-[0.07em] text-fg-faint">Result</dt>
            <dd className="mt-0.5">
              {job.autoOpenPr ? "Push branch + open PR" : job.autoPushBranch ? "Push branch" : "Keep in workspace"}
            </dd>
          </div>
        </dl>

        <div className="mt-4">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-faint">
            Recent executions
          </p>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {job.recent.map((ex) => (
              <li key={ex.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-surface-2 px-3 py-2">
                <Badge tone={EXECUTION_TONE[ex.status]} dot>
                  {ex.status}
                </Badge>
                <span className="font-mono text-[11.5px] text-fg-faint">{formatDateTime(ex.scheduledFor)}</span>
                {ex.reason ? <span className="text-[12px] text-fg-muted">{ex.reason}</span> : null}
                <span className="h-px flex-1" />
                <RelativeTime iso={ex.scheduledFor} className="text-[11.5px] text-fg-faint" />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </article>
  );
}

export default function ScheduledPage() {
  return (
    <div className="px-5 py-8 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight">Scheduled</h1>
            <p className="mt-1 max-w-2xl text-[13px] text-fg-muted">
              Jobs are claimed from Postgres with <code className="font-mono text-[12px]">FOR UPDATE SKIP LOCKED</code>,
              so they survive a restart and cannot double-fire across workers. Skipped occurrences are recorded rather
              than dropped, because a schedule that silently did nothing is indistinguishable from one that is broken.
            </p>
          </div>
          <Button variant="primary" disabled title="Scheduler lands in milestone 9">
            New schedule
          </Button>
        </div>

        <section>
          <SectionHeading aside={<span className="text-[11.5px] text-fg-faint">Tick interval 30s</span>}>
            {mockScheduledJobs.length} jobs
          </SectionHeading>
          <div className="space-y-4">
            {mockScheduledJobs.map((job) => (
              <JobCard key={job.id} job={job} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
