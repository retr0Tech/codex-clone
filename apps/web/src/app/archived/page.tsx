import { TaskList } from "../../components/TaskList";
import { SectionHeading, EmptyState } from "../../components/ui/misc";
import { mockArchivedTasks } from "../../mocks/data";

export const metadata = { title: "Archived · codex-clone" };

export default function ArchivedPage() {
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

        {mockArchivedTasks.length === 0 ? (
          <EmptyState title="Nothing archived" body="Archived tasks keep their transcript and their snapshot." />
        ) : (
          <section>
            <SectionHeading aside={<span className="text-[11.5px] text-fg-faint">Snapshots retained</span>}>
              {mockArchivedTasks.length} tasks
            </SectionHeading>
            <TaskList tasks={mockArchivedTasks} showArchived />
          </section>
        )}
      </div>
    </div>
  );
}
