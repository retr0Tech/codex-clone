import { NextResponse } from "next/server";

import type { RunBudget } from "@codex-clone/core";
import { budgetProblem } from "@codex-clone/core";
import type { CredentialName, SettingsView } from "@codex-clone/secrets";

import { credentialStore } from "../_lib/settings-store";

/**
 * Settings read/write.
 *
 *   GET  -> hints only. No ciphertext, no plaintext, no decryption.
 *   PUT  -> write. A credential field is three-state:
 *             absent / ""  -> leave the stored value alone
 *             string       -> replace it
 *             null         -> clear it
 *
 * That three-state shape is what makes the form write-only: the browser is
 * never given a value to send back, so "save" with an untouched field cannot
 * accidentally overwrite the stored credential with a mask.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await credentialStore().view());
  } catch (error) {
    return NextResponse.json({ error: message(error) }, { status: 500 });
  }
}

interface SettingsPutBody {
  githubToken?: string | null;
  openaiKey?: string | null;
  defaultModel?: string;
  maxConcurrentSandboxes?: number;
  /** Run bounds. Written as a unit or not at all -- see `parseBudget`. */
  budget?: Partial<RunBudget>;
}

export async function PUT(request: Request) {
  let body: SettingsPutBody;
  try {
    body = (await request.json()) as SettingsPutBody;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  try {
    const store = credentialStore();
    const changed: string[] = [];

    for (const name of ["githubToken", "openaiKey"] as const) {
      const value = body[name];
      if (value === undefined) continue;
      if (value === null) {
        await store.clear(name);
        changed.push(`${name}:cleared`);
        continue;
      }
      if (typeof value !== "string") {
        return NextResponse.json({ error: `${name} must be a string or null.` }, { status: 400 });
      }
      // An empty string is "the user did not touch this field", not "clear it".
      // Clearing is explicit and uses null.
      if (value.trim() === "") continue;

      const invalid = validate(name, value.trim());
      if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

      await store.set(name, value);
      changed.push(`${name}:set`);
    }

    const prefs: { defaultModel?: string; maxConcurrentSandboxes?: number; budget?: RunBudget } = {};
    if (typeof body.defaultModel === "string" && body.defaultModel.trim() !== "") {
      prefs.defaultModel = body.defaultModel.trim();
    }
    if (body.maxConcurrentSandboxes !== undefined) {
      const n = Number(body.maxConcurrentSandboxes);
      if (!Number.isInteger(n) || n < 1 || n > 16) {
        return NextResponse.json({ error: "maxConcurrentSandboxes must be an integer from 1 to 16." }, { status: 400 });
      }
      prefs.maxConcurrentSandboxes = n;
    }
    if (body.budget !== undefined) {
      // Validated with the SAME function the worker's contract exposes, so the
      // form can never store a budget the gateway would reject or clamp.
      const candidate = mergeBudget((await store.view()).budget, body.budget);
      const invalid = budgetProblem(candidate);
      if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
      prefs.budget = candidate;
    }
    await store.setPreferences(prefs);

    // Logged without any credential material: the names of what changed only.
    console.log(`[settings] updated ${changed.length > 0 ? changed.join(", ") : "preferences"}`);

    const view: SettingsView = await store.view();
    return NextResponse.json(view);
  } catch (error) {
    return NextResponse.json({ error: message(error) }, { status: 500 });
  }
}

/**
 * A partial budget over the stored one.
 *
 * An omitted bound keeps its stored value; a bound that arrives as something
 * other than a number is passed through as `NaN` so `budgetProblem` reports it,
 * rather than being silently dropped back to the stored value -- a form field
 * the user cleared must not look like a successful save of the old number.
 */
function mergeBudget(current: RunBudget, patch: Partial<RunBudget>): RunBudget {
  const pick = (key: keyof RunBudget): number =>
    patch[key] === undefined ? current[key] : Number(patch[key]);
  return { maxTurns: pick("maxTurns"), maxCostUsd: pick("maxCostUsd"), wallClockMs: pick("wallClockMs") };
}

/**
 * Shape checks only. Whether a token actually works is what "Test connection"
 * is for -- we must not reject a valid credential because GitHub introduced a
 * prefix we have not heard of.
 */
function validate(name: CredentialName, value: string): string | null {
  if (/\s/.test(value)) return `The ${label(name)} contains whitespace. Paste the token on its own.`;
  if (value.length < 16) return `That does not look like a ${label(name)} (too short).`;
  return null;
}

function label(name: CredentialName): string {
  return name === "githubToken" ? "GitHub token" : "OpenAI API key";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
