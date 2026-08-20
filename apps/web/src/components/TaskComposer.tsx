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
 * Ask mode is not a prompt instruction — it is structural (PLAN.md §3.8): the
 * tool list omits apply_patch and the workspace mounts read-only, so the hint
 * under the toggle describes a guarantee rather than a request.
 *
 * With no backend, submitting opens the fixture transcript in live playback so
 * the streaming path is what you actually see after pressing the button.
 */
export function TaskComposer() {
  const router = useRouter();
  const { repos, repo, branch, setRepoId, setBranch } = useWorkspace();
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<Mode>("code");

  const ready = prompt.trim().length > 0;

  function submit() {
    if (!ready) return;
    router.push("/tasks/task_rate_limit?stream=live");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
        <Select
          aria-label="Repository"
          value={repo.id}
          onChange={(e) => setRepoId(e.target.value)}
          className="w-auto min-w-[200px]"
        >
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.fullName}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Base branch"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          className="w-auto min-w-[150px]"
        >
          {repo.branches.map((b) => (
            <option key={b} value={b}>
              {b}
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
              ? `Ask something about ${repo.fullName}…`
              : `Describe a change to make in ${repo.fullName}…`
          }
          className="border-0 bg-transparent px-1 focus-visible:outline-none"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[12px] text-fg-faint">
            {mode === "ask"
              ? "Read-only: the sandbox has no apply_patch tool, so nothing can be written."
              : `Runs in an isolated container off ${branch}. The diff is derived by the host, not reported by the agent.`}
          </p>
          <div className="flex items-center gap-2.5">
            <span className="flex items-center gap-1.5 text-[11.5px] text-fg-faint">
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd>
            </span>
            <Button
              variant="primary"
              size="md"
              onClick={submit}
              disabled={!ready}
              className={cn(!ready && "opacity-45")}
            >
              {mode === "ask" ? "Ask" : "Start task"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
