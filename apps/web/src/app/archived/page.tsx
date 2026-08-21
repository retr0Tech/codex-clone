import { SectionHeading } from "../../components/ui/misc";
import { db } from "../api/_lib/settings-store";
import { ArchivedList } from "./ArchivedList";
import { listArchivedTasks } from "./data";
import { formatBytes, totalSnapshotBytes, type ArchivedTask } from "./format";

export const metadata = { title: "Archived · codex-clone" };
export const dynamic = "force-dynamic";

export default async function ArchivedPage() {
  let archived: ArchivedTask[] = [];
  try {
    archived = await listArchivedTasks(db());
  } catch {
    // The home page reports configuration problems in detail; this view simply
    // shows nothing rather than repeating the same banner on every route.
  }

  const held = totalSnapshotBytes(archived);

  return (
    <div className="px-5 py-8 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Archived</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-fg-muted">
            Archiving is a status change, not a deletion. The full event log is retained and the workspace is exported
            to a cold snapshot before its Docker volume is freed, so restoring recreates the workspace exactly as it
            was — on the commit it was pinned to, with uncommitted edits intact and no automatic rebase onto a base
            branch that has since moved. Rebasing is a separate, explicit action on the task page.
          </p>
        </div>

        <section>
          <SectionHeading
            aside={
              <span className="text-[11.5px] text-fg-faint">
                {held > 0 ? `${formatBytes(held)} held in the cold tier` : "Snapshots retained"}
              </span>
            }
          >
            {archived.length} {archived.length === 1 ? "task" : "tasks"}
          </SectionHeading>
          <ArchivedList rows={archived} />
        </section>
      </div>
    </div>
  );
}
