"use client";

import { useState } from "react";

import type { SettingsView } from "@codex-clone/secrets";

import { CredentialField, type TestState } from "./credential-field";

/**
 * The Settings form.
 *
 * Credentials are write-only from here: the component is handed hints, never
 * values, and it sends a credential field to the server only when the user has
 * typed into it. That is why there is no "reveal" affordance — there is
 * nothing on this side of the wire to reveal.
 */

type CredentialKey = "githubToken" | "openaiKey";

const IDLE: TestState = { status: "idle", detail: "" };

export function SettingsForm({ initial }: { initial: SettingsView }) {
  const [view, setView] = useState(initial);
  const [typed, setTyped] = useState<Record<CredentialKey, string>>({ githubToken: "", openaiKey: "" });
  const [removing, setRemoving] = useState<Record<CredentialKey, boolean>>({
    githubToken: false,
    openaiKey: false,
  });
  const [tests, setTests] = useState<Record<CredentialKey, TestState>>({
    githubToken: IDLE,
    openaiKey: IDLE,
  });
  const [defaultModel, setDefaultModel] = useState(initial.defaultModel);
  const [maxSandboxes, setMaxSandboxes] = useState(String(initial.maxConcurrentSandboxes));
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  function setTest(key: CredentialKey, state: TestState) {
    setTests((prev) => ({ ...prev, [key]: state }));
  }

  async function runTest(key: CredentialKey) {
    setTest(key, { status: "running", detail: "" });
    try {
      const response = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: key === "githubToken" ? "github" : "openai",
          // Sent only when the user typed something; otherwise the server
          // tests the credential it already holds.
          value: typed[key].trim() || undefined,
        }),
      });
      const data = (await response.json()) as { ok?: boolean; detail?: string; error?: string };
      if (data.error) {
        setTest(key, { status: "failed", detail: data.error });
        return;
      }
      setTest(key, { status: data.ok ? "ok" : "failed", detail: data.detail ?? "" });
    } catch (error) {
      setTest(key, { status: "failed", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setBanner(null);

    const payload: Record<string, unknown> = {
      defaultModel,
      maxConcurrentSandboxes: Number(maxSandboxes),
    };
    for (const key of ["githubToken", "openaiKey"] as const) {
      if (removing[key]) payload[key] = null;
      else if (typed[key].trim() !== "") payload[key] = typed[key].trim();
    }

    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as SettingsView & { error?: string };
      if (!response.ok || data.error) {
        setBanner({ kind: "error", text: data.error ?? `Save failed (${response.status}).` });
        return;
      }
      setView(data);
      setDefaultModel(data.defaultModel);
      setMaxSandboxes(String(data.maxConcurrentSandboxes));
      // Drop what was typed: the value is stored now and must not linger in
      // the DOM or in React state.
      setTyped({ githubToken: "", openaiKey: "" });
      setRemoving({ githubToken: false, openaiKey: false });
      setTests({ githubToken: IDLE, openaiKey: IDLE });
      setBanner({ kind: "ok", text: "Settings saved." });
    } catch (error) {
      setBanner({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-6">
      <CredentialField
        id="githubToken"
        label="GitHub personal access token"
        placeholder="ghp_… or github_pat_…"
        description={
          <>
            Needs <code className="font-mono">repo</code> scope. The host uses it to list repositories, mirror them
            locally and push branches. It is never passed into an agent container.
          </>
        }
        summary={view.githubToken}
        value={typed.githubToken}
        pendingRemoval={removing.githubToken}
        busy={saving}
        test={tests.githubToken}
        onChange={(v) => setTyped((prev) => ({ ...prev, githubToken: v }))}
        onTest={() => void runTest("githubToken")}
        onRemove={() => setRemoving((prev) => ({ ...prev, githubToken: true }))}
        onUndoRemove={() => setRemoving((prev) => ({ ...prev, githubToken: false }))}
      />

      <CredentialField
        id="openaiKey"
        label="OpenAI API key"
        placeholder="sk-…"
        description={
          <>
            Held by the host model gateway. Agent containers reach the model through a bind-mounted unix socket, so the
            key never enters a sandbox.
          </>
        }
        summary={view.openaiKey}
        value={typed.openaiKey}
        pendingRemoval={removing.openaiKey}
        busy={saving}
        test={tests.openaiKey}
        onChange={(v) => setTyped((prev) => ({ ...prev, openaiKey: v }))}
        onTest={() => void runTest("openaiKey")}
        onRemove={() => setRemoving((prev) => ({ ...prev, openaiKey: true }))}
        onUndoRemove={() => setRemoving((prev) => ({ ...prev, openaiKey: false }))}
      />

      <section className="rounded-lg border border-black/10 dark:border-white/15 p-5">
        <h2 className="text-sm font-semibold">Defaults</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="defaultModel" className="text-sm">
              Default model
            </label>
            <input
              id="defaultModel"
              value={defaultModel}
              disabled={saving}
              onChange={(event) => setDefaultModel(event.target.value)}
              className="rounded-md border border-black/15 dark:border-white/20 bg-transparent px-3 py-2 font-mono text-sm outline-none focus:border-black/50 dark:focus:border-white/50 disabled:opacity-50"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="maxConcurrentSandboxes" className="text-sm">
              Max concurrent sandboxes
            </label>
            <input
              id="maxConcurrentSandboxes"
              type="number"
              min={1}
              max={16}
              value={maxSandboxes}
              disabled={saving}
              onChange={(event) => setMaxSandboxes(event.target.value)}
              className="rounded-md border border-black/15 dark:border-white/20 bg-transparent px-3 py-2 font-mono text-sm outline-none focus:border-black/50 dark:focus:border-white/50 disabled:opacity-50"
            />
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
        {banner ? (
          <span
            role="status"
            className={`text-sm ${
              banner.kind === "ok" ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"
            }`}
          >
            {banner.text}
          </span>
        ) : null}
      </div>
    </form>
  );
}
