import { NextResponse } from "next/server";

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

    const prefs: { defaultModel?: string; maxConcurrentSandboxes?: number } = {};
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
