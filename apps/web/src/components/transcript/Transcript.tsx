import type { RunPhase } from "@codex-clone/core";
import type { PhaseItem, TranscriptItem } from "../../lib/eventReducer";
import { cn } from "../ui/cn";
import { ErrorRow, MessageBlock, PhaseRow, ReasoningBlock, SetupLogBlock, StatusRow, ToolCard } from "./parts";

function renderItem(item: TranscriptItem) {
  switch (item.kind) {
    case "phase":
      return <PhaseRow item={item} />;
    case "setup_log":
      return <SetupLogBlock item={item} />;
    case "reasoning":
      return <ReasoningBlock item={item} />;
    case "message":
      return <MessageBlock item={item} />;
    case "tool":
      return <ToolCard item={item} />;
    case "status":
      return <StatusRow item={item} />;
    case "error":
      return <ErrorRow item={item} />;
    case "diff":
      // The diff gets its own tab and its own inline card; see DiffCard, which
      // the task view renders. Nothing to draw in the flow itself.
      return null;
  }
}

interface Group {
  /** The phase event that opened this group, if the transcript declared one. */
  header: PhaseItem | null;
  phase: RunPhase | null;
  items: TranscriptItem[];
}

/**
 * Phase events partition the transcript rather than sitting inside it. Setup
 * gets a visually distinct region because a failing install is its own failure
 * mode (PLAN.md §3.7) and must not be mistaken for the agent misbehaving.
 */
function group(items: readonly TranscriptItem[]): Group[] {
  const groups: Group[] = [];
  let current: Group = { header: null, phase: null, items: [] };
  for (const item of items) {
    if (item.kind === "phase") {
      if (current.items.length > 0 || current.header) groups.push(current);
      current = { header: item, phase: item.phase, items: [] };
      continue;
    }
    current.items.push(item);
  }
  if (current.items.length > 0 || current.header) groups.push(current);
  return groups;
}

export function Transcript({
  items,
  renderDiff,
  className,
}: {
  items: readonly TranscriptItem[];
  /** The task view injects its diff card so the flow keeps the diff in place. */
  renderDiff?: (item: Extract<TranscriptItem, { kind: "diff" }>) => React.ReactNode;
  className?: string;
}) {
  const groups = group(items);

  return (
    <div className={cn("space-y-5", className)}>
      {groups.map((g, gi) => {
        const isSetup = g.phase === "setup";
        const body = g.items.map((item) => (
          <div key={item.id}>{item.kind === "diff" ? (renderDiff?.(item) ?? null) : renderItem(item)}</div>
        ));

        return (
          <section key={g.header?.id ?? `g${gi}`} className="space-y-3">
            {g.header ? <PhaseRow item={g.header} /> : null}
            {g.items.length === 0 ? null : isSetup ? (
              <div className="space-y-3 rounded-xl border border-border bg-bg-sunken p-3">{body}</div>
            ) : (
              <div className="space-y-4">{body}</div>
            )}
          </section>
        );
      })}
    </div>
  );
}
