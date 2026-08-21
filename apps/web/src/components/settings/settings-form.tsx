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
  // Held as strings: a number input the user has half-cleared is "" for a
  // moment, and coercing that to 0 on every keystroke fights the person typing.
  const [maxTurns, setMaxTurns] = useState(String(initial.budget.maxTurns));
  const [maxCostUsd, setMaxCostUsd] = useState(String(initial.budget.maxCostUsd));
  const [wallClockMin, setWallClockMin] = useState(String(initial.budget.wallClockMs / 60_000));
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
      budget: {
        maxTurns: Number(maxTurns),
        maxCostUsd: Number(maxCostUsd),
        // Entered in minutes because nobody thinks in milliseconds; stored in
        // milliseconds because that is what the gateway and the deadline use.
        wallClockMs: Math.round(Number(wallClockMin) * 60_000),
      },
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
      // Echoed back from what was actually stored, so a value the server
      // normalised is visible rather than only what was typed.
      setMaxTurns(String(data.budget.maxTurns));
      setMaxCostUsd(String(data.budget.maxCostUsd));
      setWallClockMin(String(data.budget.wallClockMs / 60_000));
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

      {/* Milestone 10. Budgets are enforced at the model gateway -- the one
          component every model call passes through -- and applied to each run
          as it starts, so an edit here lands on the next run. */}
      <section className="rounded-lg border border-black/10 dark:border-white/15 p-5">
        <h2 className="text-sm font-semibold">Run budget</h2>
        <p className="mt-1 max-w-2xl text-sm opacity-70">
          The bounds every new run is measured against. Reaching one does not kill the run outright: the gateway
          injects a wind-down instruction and grants exactly one more turn so the agent can commit what it has, and
          only then is the container stopped. Partial work survives either way — the workspace volume is the live
          state. A run already in flight keeps the budget it started with.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <NumberField
            id="budgetMaxTurns"
            label="Max turns"
            hint="Model calls, not tool calls."
            value={maxTurns}
            onChange={setMaxTurns}
            disabled={saving}
            min={1}
            max={200}
            step={1}
          />
          <NumberField
            id="budgetMaxCostUsd"
            label="Max cost (USD)"
            hint="Bounds a runaway run, not a normal one."
            value={maxCostUsd}
            onChange={setMaxCostUsd}
            disabled={saving}
            min={0.01}
            max={50}
            step={0.01}
          />
          <NumberField
            id="budgetWallClockMin"
            label="Wall clock (minutes)"
            hint="Enforced by a host timer too, so a wedged run still stops."
            value={wallClockMin}
            onChange={setWallClockMin}
            disabled={saving}
            min={0.5}
            max={240}
            step={0.5}
          />
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

/** The Settings page predates the shared UI kit, so it styles its own inputs. */
function NumberField({
  id,
  label,
  hint,
  value,
  onChange,
  disabled,
  min,
  max,
  step,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md border border-black/15 dark:border-white/20 bg-transparent px-3 py-2 font-mono text-sm outline-none focus:border-black/50 dark:focus:border-white/50 disabled:opacity-50"
      />
      <p className="text-xs opacity-60">{hint}</p>
    </div>
  );
}
