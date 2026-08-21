import { TaskList } from "../../components/TaskList";
import { SectionHeading } from "../../components/ui/misc";
import { listTasks } from "../api/_lib/tasks";
import { db } from "../api/_lib/settings-store";
import type { TaskView } from "../../lib/types";

export const metadata = { title: "Archived · codex-clone" };
export const dynamic = "force-dynamic";

export default async function ArchivedPage() {
  let archived: TaskView[] = [];
  try {
    archived = (await listTasks(db(), true)).filter((task) => task.status === "archived");
  } catch {
    // The home page reports configuration problems in detail; this view simply
    // shows nothing rather than repeating the same banner on every route.
  }

  return (
    <div className="px-5 py-8 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Archived</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-fg-muted">
            Archiving is a status change, not a deletion. The full event log is retained and the cold snapshot is
            kept, so restoring recreates the workspace as it was — no automatic rebase onto a base branch that has
            since moved.
          </p>
        </div>

        <section>
          <SectionHeading aside={<span className="text-[11.5px] text-fg-faint">Snapshots retained</span>}>
            {archived.length} {archived.length === 1 ? "task" : "tasks"}
          </SectionHeading>
          <TaskList
            tasks={archived}
            showArchived
            empty={{
              title: "Nothing archived",
              body: "Archived tasks keep their transcript and their snapshot. Archiving lands with the cold-snapshot reaper in milestone 8.",
            }}
          />
        </section>
      </div>
    </div>
  );
}
