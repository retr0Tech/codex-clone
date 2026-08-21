import Link from "next/link";
import { TaskComposer } from "../components/TaskComposer";
import { TaskList } from "../components/TaskList";
import { SectionHeading } from "../components/ui/misc";
import { listTasks } from "./api/_lib/tasks";
import { db } from "./api/_lib/settings-store";
import type { TaskView } from "../lib/types";

/**
 * Server-rendered from Postgres, so the list is right on first paint rather
 * than after a client fetch. The sidebar polls the same data for the parts that
 * change while you are looking at them; this page is the snapshot you arrived
 * with.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  let tasks: TaskView[] = [];
  let problem: string | null = null;
  try {
    tasks = await listTasks(db());
  } catch (error) {
    // A missing DATABASE_URL or an unmigrated database must render as something
    // a human can act on, not as a stack trace in the terminal.
    problem = error instanceof Error ? error.message : String(error);
  }

  const inFlight = tasks.filter((t) => t.status === "queued" || t.status === "running");
  const rest = tasks.filter((t) => t.status !== "queued" && t.status !== "running");

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

        {problem ? (
          <p className="rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-[13px] text-danger">
            {problem}
          </p>
        ) : null}

        {inFlight.length > 0 ? (
          <section>
            <SectionHeading
              aside={
                <span className="text-[11.5px] text-fg-faint">
                  The worker runs at most 3 containers; the rest wait in Postgres.
                </span>
              }
            >
              In flight
            </SectionHeading>
            <TaskList tasks={inFlight} />
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
          <TaskList
            tasks={rest}
            empty={{
              title: "No tasks yet",
              body: "Pick a repository and a branch above, describe a change, and the worker will claim it out of the queue.",
            }}
          />
        </section>
      </div>
    </div>
  );
}
