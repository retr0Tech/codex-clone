import type { DiffItem } from "../../lib/eventReducer";
import { countChanges, parsePatch, type PatchFile } from "../../lib/patch";
import { Badge } from "../ui/Badge";
import { Disclosure } from "../ui/Disclosure";
import { DiffStat } from "../ui/misc";
import { cn } from "../ui/cn";
import { shortSha } from "../../lib/format";

const STATUS_TONE = {
  added: "ok",
  modified: "info",
  deleted: "danger",
  renamed: "warn",
} as const;

const STATUS_LETTER = { added: "A", modified: "M", deleted: "D", renamed: "R" } as const;

function PatchLines({ file }: { file: PatchFile }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-[12px] leading-[1.5]">
        <tbody>
          {file.lines.map((line, i) => {
            const tone =
              line.type === "add"
                ? "bg-add-bg text-add-fg"
                : line.type === "del"
                  ? "bg-del-bg text-del-fg"
                  : line.type === "hunk"
                    ? "bg-hunk-bg text-hunk-fg"
                    : line.type === "meta"
                      ? "text-fg-faint"
                      : "text-fg-muted";
            return (
              <tr key={i} className={tone}>
                <td className="w-10 select-none border-r border-border px-2 text-right align-top text-[11px] tabular-nums opacity-55">
                  {line.oldNo ?? ""}
                </td>
                <td className="w-10 select-none border-r border-border px-2 text-right align-top text-[11px] tabular-nums opacity-55">
                  {line.newNo ?? ""}
                </td>
                <td className="w-5 select-none px-1.5 text-center align-top opacity-70">
                  {line.type === "add" ? "+" : line.type === "del" ? "-" : ""}
                </td>
                <td className="whitespace-pre px-1 pr-3 align-top">{line.text === "" ? " " : line.text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The diff is derived by the host with `git diff <baseSha>` after every turn
 * (PLAN.md §3.8), so this view renders the repository's own account of what
 * changed — never the agent's summary of what it believes it did. The file
 * list and the patch come from the same event for that reason.
 */
export function DiffView({ diff, defaultOpenFirst = true }: { diff: DiffItem; defaultOpenFirst?: boolean }) {
  const parsed = parsePatch(diff.patch);
  const totals = diff.files.reduce(
    (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { additions: 0, deletions: 0 },
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-surface-2 px-3.5 py-2.5">
        <span className="text-[13px] font-medium">
          {diff.files.length} {diff.files.length === 1 ? "file" : "files"} changed
        </span>
        <DiffStat additions={totals.additions} deletions={totals.deletions} />
        <span className="h-px flex-1" />
        <span className="font-mono text-[11.5px] text-fg-faint">
          base {shortSha(diff.baseSha)}
        </span>
        {diff.truncated ? <Badge tone="warn">patch truncated</Badge> : null}
      </div>

      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {diff.files.map((file) => (
          <li key={file.path} className="flex items-center gap-3 bg-surface px-3.5 py-2">
            <span
              className={cn(
                "grid size-4 shrink-0 place-items-center rounded-[3px] text-[10px] font-bold",
                file.status === "added" && "bg-add-bg text-add-fg",
                file.status === "modified" && "bg-info-soft text-info",
                file.status === "deleted" && "bg-del-bg text-del-fg",
                file.status === "renamed" && "bg-warn-soft text-warn",
              )}
              title={file.status}
              aria-label={file.status}
            >
              {STATUS_LETTER[file.status]}
            </span>
            <a
              href={`#patch-${encodeURIComponent(file.path)}`}
              className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg hover:underline"
            >
              {file.path}
            </a>
            <Badge tone={STATUS_TONE[file.status]}>{file.status}</Badge>
            <DiffStat additions={file.additions} deletions={file.deletions} />
          </li>
        ))}
      </ul>

      {parsed.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3.5 py-6 text-center text-[13px] text-fg-muted">
          No patch body was carried on this event.
        </p>
      ) : (
        <div className="space-y-2">
          {parsed.map((file, i) => (
            <div
              key={file.path || i}
              id={`patch-${encodeURIComponent(file.path)}`}
              className="overflow-hidden rounded-lg border border-border bg-surface scroll-mt-4"
            >
              <Disclosure
                defaultOpen={defaultOpenFirst && i === 0}
                className="px-3 py-2"
                bodyClassName="mt-2 -mx-3 -mb-2 border-t border-border"
                summary={
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{file.path || "patch"}</span>
                    <DiffStat {...countChanges(file)} />
                  </span>
                }
              >
                <PatchLines file={file} />
              </Disclosure>
            </div>
          ))}
        </div>
      )}

      {diff.truncated ? (
        <p className="text-[12px] text-warn">
          This patch was truncated for transport. The complete diff is available from the run&rsquo;s workspace.
        </p>
      ) : null}
    </div>
  );
}

/** Compact inline form, rendered in the transcript flow where the event landed. */
export function DiffCard({ diff }: { diff: DiffItem }) {
  const totals = diff.files.reduce(
    (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { additions: 0, deletions: 0 },
  );
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <Disclosure
        className="px-3.5 py-2.5"
        bodyClassName="mt-3"
        summary={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[13px] font-medium">Diff against {shortSha(diff.baseSha)}</span>
            <span className="text-[12.5px] text-fg-muted">
              {diff.files.length} {diff.files.length === 1 ? "file" : "files"}
            </span>
            <DiffStat additions={totals.additions} deletions={totals.deletions} />
            {diff.truncated ? <Badge tone="warn">truncated</Badge> : null}
          </span>
        }
      >
        <DiffView diff={diff} defaultOpenFirst={false} />
      </Disclosure>
    </div>
  );
}
