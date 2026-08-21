import Link from "next/link";
import { TaskComposer } from "../components/TaskComposer";
import { TaskList } from "../components/TaskList";
import { SectionHeading } from "../components/ui/misc";
import { Badge } from "../components/ui/Badge";
import { mockScheduledJobs, mockTasks } from "../mocks/data";

export default function Home() {
  const queued = mockTasks.filter((t) => t.status === "queued" || t.status === "running");
  const rest = mockTasks.filter((t) => t.status !== "queued" && t.status !== "running");
  const nextJob = mockScheduledJobs.find((j) => j.enabled);

  return (
    <div className="px-5 py-8 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-8">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">What should the agent work on?</h1>
          <p className="mt-1 text-[13px] text-fg-muted">
            Each task gets its own container off the branch you pick. Nothing you type leaves this machine.
          </p>
        </div>

        <TaskComposer />

        {queued.length > 0 ? (
          <section>
            <SectionHeading
              aside={
                <span className="text-[11.5px] text-fg-faint">
                  Worker runs at most 3 containers; the rest wait in Postgres.
                </span>
              }
            >
              In flight
            </SectionHeading>
            <TaskList tasks={queued} />
          </section>
        ) : null}

        <section>
          <SectionHeading
            aside={
              <Link href="/archived" className="text-[12px] text-fg-muted hover:text-fg">
                View archived →
              </Link>
            }
          >
            Recent tasks
          </SectionHeading>
          <TaskList tasks={rest} />
        </section>

        {nextJob ? (
          <section>
            <SectionHeading
              aside={
                <Link href="/scheduled" className="text-[12px] text-fg-muted hover:text-fg">
                  All schedules →
                </Link>
              }
            >
              Next scheduled run
            </SectionHeading>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-surface px-4 py-3">
              <span className="text-[13.5px] font-medium">{nextJob.name}</span>
              <Badge tone="neutral">{nextJob.cronHuman}</Badge>
              <span className="font-mono text-[11.5px] text-fg-faint">{nextJob.timezone}</span>
              <span className="h-px flex-1" />
              <span className="text-[12.5px] text-fg-muted">
                {nextJob.autoOpenPr ? "Pushes a branch and opens a PR" : "Pushes a branch"}
              </span>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
