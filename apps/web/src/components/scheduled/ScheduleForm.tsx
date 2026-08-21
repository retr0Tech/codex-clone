"use client";

import { useEffect, useMemo, useState } from "react";
import type { BranchView } from "../../lib/types";
import type { OnOverlap, ScheduledJobView } from "../../lib/scheduled";
import { useWorkspace } from "../WorkspaceContext";
import { Button } from "../ui/Button";
import { Label, Segmented, Select, Textarea } from "../ui/Field";
import { CheckField, TextInput } from "./fields";

/**
 * Create or edit a schedule.
 *
 * One form for both, because "edit" and "create" differ only in where the
 * initial values come from and which HTTP verb they end up as. The fields are
 * exactly what the brief asks a schedule to carry -- repo, branch, prompt, cron
 * expression, timezone, and the overlap and catch-up options -- plus what
 * happens to the result, which is the field an unattended job cannot do
 * without.
 *
 * Validation is the server's job and is not duplicated here: the cron
 * expression is resolved to a real first occurrence by the API before the row
 * is written, and whatever it says comes back into `error`. A second,
 * approximate parser in the browser would only ever be wrong in a different
 * way from the one that counts.
 */

export interface ScheduleDraft {
  name: string;
  repoFullName: string;
  baseBranch: string;
  prompt: string;
  cronExpr: string;
  timezone: string;
  onOverlap: OnOverlap;
  catchup: boolean;
  autoPushBranch: boolean;
  autoOpenPr: boolean;
}

/** Whatever the browser is set to. A schedule is usually meant in local time. */
function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function emptyDraft(repoFullName: string, baseBranch: string): ScheduleDraft {
  return {
    name: "",
    repoFullName,
    baseBranch,
    prompt: "",
    cronExpr: "0 3 * * *",
    timezone: localTimezone(),
    onOverlap: "skip",
    catchup: true,
    autoPushBranch: true,
    autoOpenPr: false,
  };
}

export function draftFrom(job: ScheduledJobView): ScheduleDraft {
  return {
    name: job.name,
    repoFullName: job.repoFullName,
    baseBranch: job.baseBranch,
    prompt: job.prompt,
    cronExpr: job.cronExpr,
    timezone: job.timezone,
    onOverlap: job.onOverlap,
    catchup: job.catchup,
    autoPushBranch: job.autoPushBranch,
    autoOpenPr: job.autoOpenPr,
  };
}

/** IANA names this platform knows, so the timezone field cannot be mistyped. */
function timezoneOptions(current: string): string[] {
  let all: string[] = [];
  try {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (supported) all = supported("timeZone");
  } catch {
    all = [];
  }
  if (all.length === 0) all = ["UTC", localTimezone()];
  return all.includes(current) ? all : [current, ...all];
}

/** Branches for the repo THIS form is pointed at, which need not be the sidebar's. */
function useBranchesFor(repoFullName: string): { branches: BranchView[]; loading: boolean } {
  const [branches, setBranches] = useState<BranchView[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const [owner, name] = repoFullName.split("/");
    if (!owner || !name) {
      setBranches([]);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch(
          `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches`,
          { signal: controller.signal, cache: "no-store" },
        );
        const body = (await response.json()) as { branches?: BranchView[] };
        if (!controller.signal.aborted) setBranches(body.branches ?? []);
      } catch {
        // A branch list we could not load leaves whatever is typed in place,
        // which is still a valid ref for the worker to resolve.
        if (!controller.signal.aborted) setBranches([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [repoFullName]);

  return { branches, loading };
}

export function ScheduleForm({
  draft,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
  busy,
  error,
  /** Editing cannot move a job to another repository; that is a different job. */
  lockRepo = false,
}: {
  draft: ScheduleDraft;
  onChange: (next: ScheduleDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  lockRepo?: boolean;
}) {
  const { repos } = useWorkspace();
  const { branches, loading: loadingBranches } = useBranchesFor(draft.repoFullName);
  const zones = useMemo(() => timezoneOptions(draft.timezone), [draft.timezone]);
  const set = <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) =>
    onChange({ ...draft, [key]: value });

  const ready = draft.prompt.trim() !== "" && draft.repoFullName !== "" && draft.cronExpr.trim() !== "" && !busy;

  return (
    <form
      className="space-y-4 rounded-xl border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSubmit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="sched-name">Name</Label>
          <TextInput
            id="sched-name"
            value={draft.name}
            placeholder="Nightly dependency audit"
            maxLength={80}
            onChange={(e) => set("name", e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="sched-repo">Repository</Label>
          <Select
            id="sched-repo"
            value={draft.repoFullName}
            disabled={lockRepo || repos.length === 0}
            onChange={(e) => onChange({ ...draft, repoFullName: e.target.value, baseBranch: "" })}
          >
            {repos.length === 0 || !repos.some((r) => r.fullName === draft.repoFullName) ? (
              <option value={draft.repoFullName}>{draft.repoFullName || "no repositories"}</option>
            ) : null}
            {repos.map((r) => (
              <option key={r.fullName} value={r.fullName}>
                {r.fullName}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="sched-branch">Base branch</Label>
          <Select
            id="sched-branch"
            value={draft.baseBranch}
            disabled={loadingBranches && branches.length === 0}
            onChange={(e) => set("baseBranch", e.target.value)}
          >
            {draft.baseBranch === "" || !branches.some((b) => b.name === draft.baseBranch) ? (
              <option value={draft.baseBranch}>
                {draft.baseBranch || (loadingBranches ? "loading…" : "pick a branch")}
              </option>
            ) : null}
            {branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="sched-cron">Cron expression</Label>
          <TextInput
            id="sched-cron"
            value={draft.cronExpr}
            spellCheck={false}
            className="font-mono text-[13px]"
            placeholder="0 3 * * *"
            onChange={(e) => set("cronExpr", e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="sched-tz">Timezone</Label>
          <Select id="sched-tz" value={draft.timezone} onChange={(e) => set("timezone", e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <p className="-mt-2 text-[11.5px] text-fg-faint">
        Five fields — minute, hour, day of month, month, day of week — or a nickname such as{" "}
        <code className="font-mono">@daily</code>. Resolved in the timezone above, so the hour you mean is the hour it
        runs, daylight saving included.
      </p>

      <div>
        <Label htmlFor="sched-prompt">Prompt</Label>
        <Textarea
          id="sched-prompt"
          rows={3}
          value={draft.prompt}
          placeholder="Describe the change the agent should make each time this runs…"
          onChange={(e) => set("prompt", e.target.value)}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>When the previous execution is still running</Label>
          <Segmented<OnOverlap>
            value={draft.onOverlap}
            onChange={(v) => set("onOverlap", v)}
            label="On overlap"
            size="sm"
            options={[
              { value: "skip", label: "Skip", hint: "Record a skipped occurrence and wait for the next one" },
              { value: "queue", label: "Queue", hint: "Start it anyway; the run queue serialises the containers" },
            ]}
          />
          <CheckField
            checked={draft.catchup}
            onChange={(v) => set("catchup", v)}
            label="Catch up after downtime"
            hint="Fires once on recovery, never once per missed occurrence. Off records the misses as skipped."
          />
        </div>
        <div className="space-y-2">
          <Label>What happens to the result</Label>
          <CheckField
            checked={draft.autoPushBranch}
            onChange={(v) => onChange({ ...draft, autoPushBranch: v, autoOpenPr: v ? draft.autoOpenPr : false })}
            label="Push the branch"
            hint="scheduled/<job>/<timestamp>. An unattended diff that dies with its container is worthless."
          />
          <CheckField
            checked={draft.autoOpenPr}
            disabled={!draft.autoPushBranch}
            onChange={(v) => set("autoOpenPr", v)}
            label="Open a pull request"
            hint="Needs a branch to open from."
          />
        </div>
      </div>

      {error ? (
        <p className="rounded-md border border-danger/40 bg-danger-soft px-2.5 py-1.5 text-[12px] text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={!ready}>
          {busy ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
