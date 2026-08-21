import { ScheduleManager } from "../../components/scheduled/ScheduleManager";
import { db } from "../api/_lib/settings-store";
import { listScheduledJobs } from "../api/scheduled-jobs/_lib/jobs";
import type { ScheduledJobView } from "../../lib/scheduled";

/**
 * Server-rendered from Postgres, so the schedules and their history are right
 * on first paint rather than after a client fetch. `ScheduleManager` takes over
 * from there and polls, because an occurrence can fire, run and settle between
 * two page loads.
 */

export const metadata = { title: "Scheduled · codex-clone" };
export const dynamic = "force-dynamic";

export default async function ScheduledPage() {
  let jobs: ScheduledJobView[] = [];
  let problem: string | null = null;
  try {
    jobs = await listScheduledJobs(db());
  } catch (error) {
    // A missing DATABASE_URL or an unmigrated database must render as something
    // a human can act on, not as a stack trace in the terminal.
    problem = error instanceof Error ? error.message : String(error);
  }

  return (
    <div className="px-5 py-8 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        {problem ? (
          <p className="rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-[13px] text-danger">
            {problem}
          </p>
        ) : null}
        <ScheduleManager initialJobs={jobs} />
      </div>
    </div>
  );
}
