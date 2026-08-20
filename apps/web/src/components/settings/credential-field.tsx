"use client";

import type { ReactNode } from "react";

import type { CredentialSummary } from "@codex-clone/secrets";

export type TestStatus = "idle" | "running" | "ok" | "failed";

export interface TestState {
  status: TestStatus;
  detail: string;
}

export interface CredentialFieldProps {
  id: string;
  label: string;
  description: ReactNode;
  placeholder: string;
  /** Hint-derived summary from the server. Never contains the credential. */
  summary: CredentialSummary;
  /** What the user has typed this session. Empty means "leave it alone". */
  value: string;
  /** True once the user has pressed Remove but not yet saved. */
  pendingRemoval: boolean;
  busy: boolean;
  test: TestState;
  onChange: (value: string) => void;
  onTest: () => void;
  onRemove: () => void;
  onUndoRemove: () => void;
}

/**
 * One write-only credential input.
 *
 * The input is always empty on load — there is nothing to prefill it with,
 * because the server only ever sends the last four characters. The stored
 * value is shown as a mask beside the field, and the field is submitted only
 * when the user actually types something.
 */
export function CredentialField(props: CredentialFieldProps) {
  const { summary, value, pendingRemoval, busy, test } = props;
  const typed = value.trim() !== "";

  return (
    <section className="rounded-lg border border-black/10 dark:border-white/15 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor={props.id} className="text-sm font-semibold">
          {props.label}
        </label>
        <StoredBadge summary={summary} pendingRemoval={pendingRemoval} typed={typed} />
      </div>

      <p className="mt-1 text-sm text-black/60 dark:text-white/60">{props.description}</p>

      <input
        id={props.id}
        name={props.id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        disabled={busy || pendingRemoval}
        value={value}
        placeholder={summary.present ? "Enter a new value to replace it" : props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
        className="mt-3 w-full rounded-md border border-black/15 dark:border-white/20 bg-transparent px-3 py-2 font-mono text-sm outline-none focus:border-black/50 dark:focus:border-white/50 disabled:opacity-50"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={props.onTest}
          disabled={busy || test.status === "running" || (!typed && !summary.present) || pendingRemoval}
          className="rounded-md border border-black/20 dark:border-white/25 px-3 py-1.5 text-sm font-medium hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          {test.status === "running" ? "Testing…" : "Test connection"}
        </button>

        {summary.present && !pendingRemoval ? (
          <button
            type="button"
            onClick={props.onRemove}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-red-700 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-40"
          >
            Remove
          </button>
        ) : null}

        {pendingRemoval ? (
          <button
            type="button"
            onClick={props.onUndoRemove}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm font-medium underline underline-offset-4 disabled:opacity-40"
          >
            Undo
          </button>
        ) : null}
      </div>

      {test.status === "ok" || test.status === "failed" ? (
        <p
          role="status"
          className={`mt-3 rounded-md px-3 py-2 text-sm ${
            test.status === "ok"
              ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
              : "bg-red-500/10 text-red-800 dark:text-red-300"
          }`}
        >
          {test.detail}
        </p>
      ) : null}
    </section>
  );
}

function StoredBadge({
  summary,
  pendingRemoval,
  typed,
}: {
  summary: CredentialSummary;
  pendingRemoval: boolean;
  typed: boolean;
}) {
  if (pendingRemoval) {
    return <span className="text-xs font-medium text-red-700 dark:text-red-400">Will be removed on save</span>;
  }
  if (typed) {
    return <span className="text-xs font-medium text-amber-700 dark:text-amber-400">Unsaved change</span>;
  }
  if (!summary.present) {
    return <span className="text-xs text-black/45 dark:text-white/45">Not configured</span>;
  }
  return (
    <span className="text-xs text-black/60 dark:text-white/60">
      Stored <code className="font-mono">{summary.masked}</code>
    </span>
  );
}
