import type { ReactNode } from "react";
import type {
  ErrorItem,
  MessageItem,
  PhaseItem,
  ReasoningItem,
  SetupLogItem,
  StatusItem,
  ToolItem,
} from "../../lib/eventReducer";
import { Badge } from "../ui/Badge";
import { Disclosure } from "../ui/Disclosure";
import { cn } from "../ui/cn";
import { formatDuration, formatTime, summariseArgs } from "../../lib/format";
import { PHASE_META, STATUS_META } from "../../lib/status";

/* -------------------------------------------------------------------------- */
/* phase                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Phase transitions are rules across the transcript rather than cards. Setup is
 * given a distinct treatment because "the install died" and "the agent failed"
 * are different problems and must not look alike (PLAN.md §3.7).
 */
export function PhaseRow({ item }: { item: PhaseItem }) {
  const meta = PHASE_META[item.phase];
  const isSetup = item.phase === "setup";
  return (
    <div className="flex items-center gap-3 py-1">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium",
          isSetup ? "border-border-strong bg-surface-3 text-fg-muted" : "border-transparent bg-accent-soft text-accent",
        )}
      >
        {isSetup ? (
          <svg viewBox="0 0 12 12" className="size-3" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="1.6" y="2.4" width="8.8" height="7.2" rx="1.4" />
            <path d="M3.4 5l1.4 1.2-1.4 1.2M6.2 7.6h2.4" strokeLinecap="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 12 12" className="size-3" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="6" cy="6" r="4.4" />
            <path d="M6 3.6V6l1.6 1" strokeLinecap="round" />
          </svg>
        )}
        {meta.label}
      </span>
      <span className="hidden text-[12px] text-fg-faint sm:block">{meta.blurb}</span>
      <span className="h-px flex-1 bg-border" />
      <span className="font-mono text-[11px] text-fg-faint tabular-nums">{formatTime(item.at)}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* setup_log                                                                   */
/* -------------------------------------------------------------------------- */

export function SetupLogBlock({ item }: { item: SetupLogItem }) {
  const errors = item.lines.filter((l) => l.stream === "stderr").length;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between gap-3 bg-surface-3 px-3 py-1.5">
        <span className="font-mono text-[11.5px] text-fg-muted">setup script</span>
        <span className="flex items-center gap-2 text-[11px] text-fg-faint tabular-nums">
          {errors > 0 ? <Badge tone="warn">{errors} stderr</Badge> : null}
          {item.lines.length} lines
        </span>
      </div>
      <pre className="max-h-80 overflow-auto bg-term-bg px-3 py-2.5 font-mono text-[12px] leading-[1.55] text-term-fg">
        {item.lines.map((line, i) => (
          <div key={i} className={cn("whitespace-pre-wrap break-words", line.stream === "stderr" && "text-term-err")}>
            {line.text === "" ? " " : line.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* reasoning                                                                   */
/* -------------------------------------------------------------------------- */

/** Deliberately quieter than a message: it is the agent thinking, not answering. */
export function ReasoningBlock({ item }: { item: ReasoningItem }) {
  return (
    <div className="border-l-2 border-border pl-3.5">
      <p className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.09em] text-fg-faint">Reasoning</p>
      <p className="text-[13px] leading-relaxed text-fg-muted italic">{item.text}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* message                                                                     */
/* -------------------------------------------------------------------------- */

/** Minimal inline markdown: `code` and **bold** only. Enough, and no dependency. */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(
        <code
          key={`c${key++}`}
          className="rounded border border-border bg-surface-3 px-1 py-px font-mono text-[12.5px]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(
        <strong key={`b${key++}`} className="font-semibold">
          {token.slice(2, -2)}
        </strong>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function MessageBlock({ item }: { item: MessageItem }) {
  const isUser = item.role === "user";
  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3",
        isUser ? "border-border bg-surface-3" : "border-border bg-surface",
      )}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[10.5px] font-medium uppercase tracking-[0.09em] text-fg-faint">
          {isUser ? "You" : "Assistant"}
        </span>
        {item.streaming ? (
          <span className="text-[10.5px] font-medium uppercase tracking-[0.09em] text-accent">streaming</span>
        ) : null}
      </div>
      <div className="space-y-2.5 text-[13.5px] leading-relaxed text-fg">
        {item.text.split("\n\n").map((para, i, all) => (
          <p key={i} className={cn(item.streaming && i === all.length - 1 && "caret")}>
            {renderInline(para)}
          </p>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* tool_call / tool_result                                                     */
/* -------------------------------------------------------------------------- */

const TOOL_LABEL: Record<string, string> = {
  shell: "shell",
  apply_patch: "apply_patch",
  read_file: "read_file",
  grep: "grep",
};

export function ToolCard({ item }: { item: ToolItem }) {
  const result = item.result;
  const pending = result === null;
  const failed = result !== null && !result.ok;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-surface",
        failed ? "border-danger/40" : "border-border",
      )}
    >
      <Disclosure
        className="px-3 py-2"
        bodyClassName="pt-0"
        summary={
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[11.5px] font-medium text-fg">
              {TOOL_LABEL[item.tool] ?? item.tool}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-muted">
              {summariseArgs(item.args)}
            </span>
            {pending ? (
              <Badge tone="info" dot>
                running
              </Badge>
            ) : (
              <>
                {result.truncated ? <Badge tone="warn">truncated</Badge> : null}
                {result.exitCode !== undefined ? (
                  <span
                    className={cn(
                      "font-mono text-[11px] tabular-nums",
                      result.exitCode === 0 ? "text-fg-faint" : "text-danger",
                    )}
                  >
                    exit {result.exitCode}
                  </span>
                ) : null}
                <span className="font-mono text-[11px] tabular-nums text-fg-faint">
                  {formatDuration(result.durationMs)}
                </span>
              </>
            )}
          </span>
        }
      >
        <div className="space-y-2 pl-5">
          <div>
            <p className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.09em] text-fg-faint">Arguments</p>
            <pre className="overflow-auto rounded-md border border-border bg-surface-2 px-2.5 py-2 font-mono text-[12px] leading-relaxed text-fg-muted">
              {JSON.stringify(item.args, null, 2)}
            </pre>
          </div>
          {result ? (
            <div>
              <p className="mb-1 flex items-center gap-2 text-[10.5px] font-medium uppercase tracking-[0.09em] text-fg-faint">
                Output
                {!result.ok ? <span className="text-danger normal-case tracking-normal">failed</span> : null}
              </p>
              <pre className="max-h-96 overflow-auto rounded-md bg-term-bg px-2.5 py-2 font-mono text-[12px] leading-[1.55] text-term-fg whitespace-pre-wrap break-words">
                {result.output}
              </pre>
              {result.truncated ? (
                // Truncation has to be visible: a silently clipped log is how
                // people conclude the agent did nothing.
                <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-warn">
                  <svg viewBox="0 0 12 12" className="size-3" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4">
                    <circle cx="6" cy="6" r="4.6" />
                    <path d="M6 3.6v2.8M6 8.2h.01" strokeLinecap="round" />
                  </svg>
                  Output truncated for transport. The full log is kept with the run.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-[12.5px] text-fg-faint">Waiting for the result…</p>
          )}
        </div>
      </Disclosure>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* status / error                                                              */
/* -------------------------------------------------------------------------- */

export function StatusRow({ item }: { item: StatusItem }) {
  const meta = STATUS_META[item.status];
  return (
    <div
      className={cn(
        "rounded-lg border px-3.5 py-3",
        meta.tone === "ok" && "border-ok/35 bg-ok-soft",
        meta.tone === "warn" && "border-warn/35 bg-warn-soft",
        meta.tone === "danger" && "border-danger/35 bg-danger-soft",
        meta.tone === "info" && "border-info/35 bg-info-soft",
        meta.tone === "neutral" && "border-border bg-surface-2",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={meta.tone} dot>
          {meta.label}
        </Badge>
        <span className="font-mono text-[11px] text-fg-faint tabular-nums">{formatTime(item.at)}</span>
      </div>
      <p className="mt-1.5 text-[13px] text-fg">{item.reason ?? meta.blurb}</p>
    </div>
  );
}

export function ErrorRow({ item }: { item: ErrorItem }) {
  return (
    <div className="rounded-lg border border-danger/35 bg-danger-soft px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="danger" dot>
          Error
        </Badge>
        <code className="font-mono text-[11.5px] text-danger">{item.code}</code>
        {item.retryable ? <Badge tone="neutral">retryable</Badge> : null}
      </div>
      <p className="mt-1.5 text-[13px] text-fg">{item.message}</p>
    </div>
  );
}
