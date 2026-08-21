"use client";

import { useRouter } from "next/navigation";
import { useState, type KeyboardEvent } from "react";
import { useWorkspace } from "./WorkspaceContext";
import { Button } from "./ui/Button";
import { Segmented, Select, Textarea } from "./ui/Field";
import { Kbd } from "./ui/misc";
import { cn } from "./ui/cn";

type Mode = "code" | "ask";

/**
 * Create a task: pick repo and branch, write a prompt, choose the mode.
 *
 * Submitting POSTs to `/api/tasks`, which resolves the branch to a SHA
 * server-side and queues the first run; the worker claims it out of Postgres.
 * Note what is NOT sent: a base SHA. The branch name is the input and the
 * server does the resolving, because every diff in the system is derived
 * against `tasks.base_sha` and a client-chosen pin would let the caller decide
 * what "changed" means.
 *
 * Ask mode is not a prompt instruction -- it is structural (PLAN.md §3.8): the
 * tool list omits apply_patch and the workspace mounts read-only, so the hint
 * under the toggle describes a guarantee rather than a request.
 */
export function TaskComposer() {
  const router = useRouter();
  const { repo, repos, branches, branch, loadingRepos, loadingBranches, error, setRepoFullName, setBranch } =
    useWorkspace();
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<Mode>("code");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const ready = prompt.trim().length > 0 && repo !== null && branch !== "" && !submitting;

  async function submit() {
    if (!ready || !repo) return;
    setSubmitting(true);
    setFailure(null);

    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoFullName: repo.fullName,
          baseBranch: branch,
          prompt: prompt.trim(),
          mode,
        }),
      });
      const body = (await response.json()) as { taskId?: string; error?: string };
      if (!response.ok || !body.taskId) {
        setFailure(body.error ?? `task creation failed with ${response.status}`);
        return;
      }
      // The run is queued at this point, not started. The task page subscribes
      // to the socket and shows it move through the queue.
      router.push(`/tasks/${body.taskId}`);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  }

  const repoLabel = repo?.fullName ?? (loadingRepos ? "loading…" : "no repositories");

  return (
    <div className="rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
        <Select
          aria-label="Repository"
          value={repo?.fullName ?? ""}
          onChange={(e) => setRepoFullName(e.target.value)}
          disabled={loadingRepos || repos.length === 0}
          className="w-auto min-w-[200px]"
        >
          {repos.length === 0 ? <option value="">{repoLabel}</option> : null}
          {repos.map((r) => (
            <option key={r.fullName} value={r.fullName}>
              {r.fullName}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Base branch"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          disabled={loadingBranches || branches.length === 0}
          className="w-auto min-w-[150px]"
        >
          {/* The recorded default is a valid ref even before the list lands. */}
          {branches.length === 0 && branch !== "" ? <option value={branch}>{branch}</option> : null}
          {branches.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
        </Select>
        <span className="h-px flex-1" />
        <Segmented<Mode>
          value={mode}
          onChange={setMode}
          label="Mode"
          options={[
            { value: "code", label: "Code", hint: "Full tool list, writable workspace" },
            { value: "ask", label: "Ask", hint: "No apply_patch, workspace mounted read-only" },
          ]}
        />
      </div>

      <div className="p-3">
        <Textarea
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            mode === "ask"
              ? `Ask something about ${repoLabel}…`
              : `Describe a change to make in ${repoLabel}…`
          }
          className="border-0 bg-transparent px-1 focus-visible:outline-none"
        />
        {error ? (
          <p className="mt-2 rounded-md border border-warn/40 bg-warn-soft px-2.5 py-1.5 text-[12px] text-warn">
            {error}
          </p>
        ) : null}
        {failure ? (
          <p className="mt-2 rounded-md border border-danger/40 bg-danger-soft px-2.5 py-1.5 text-[12px] text-danger">
            {failure}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[12px] text-fg-faint">
            {mode === "ask"
              ? "Read-only: the sandbox has no apply_patch tool, so nothing can be written."
              : `Runs in an isolated container off ${branch || "the default branch"}. The diff is derived by the host, not reported by the agent.`}
          </p>
          <div className="flex items-center gap-2.5">
            <span className="flex items-center gap-1.5 text-[11.5px] text-fg-faint">
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd>
            </span>
            <Button
              variant="primary"
              size="md"
              onClick={() => void submit()}
              disabled={!ready}
              className={cn(!ready && "opacity-45")}
            >
              {submitting ? "Queueing…" : mode === "ask" ? "Ask" : "Start task"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
