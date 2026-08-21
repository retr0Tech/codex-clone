/**
 * The credential store: the only component in the system that turns a stored
 * ciphertext back into a usable GitHub PAT or OpenAI key.
 *
 * Two rules it enforces on every caller's behalf:
 *
 *  1. Every decrypt is followed immediately by `registerSecret()`, so from the
 *     first moment a credential exists in memory the redacting logger in
 *     @codex-clone/core will scrub it from anything written out — including
 *     from third-party error messages that happen to echo a request URL.
 *
 *  2. Reading the *presence* of a credential never decrypts it. The Settings
 *     page renders from the `*_hint` columns, so the ordinary page load does
 *     no cryptography and puts no plaintext in the web process at all.
 *
 * Persistence is behind `SettingsRepository` rather than reaching for Drizzle
 * directly, so the crypto and redaction behaviour above is unit-testable with
 * no Postgres anywhere near it.
 */

import type { RunBudget } from "@codex-clone/core";
import { DEFAULT_BUDGET, registerSecret } from "@codex-clone/core";
import { decryptSecret, encryptSecret, hintOf, maskFromHint, type EncryptionKey } from "./crypto.js";

/** The subset of the `settings` row this package owns. */
export interface StoredSettings {
  githubTokenEnc: string | null;
  openaiKeyEnc: string | null;
  githubTokenHint: string | null;
  openaiKeyHint: string | null;
  defaultModel: string;
  maxConcurrentSandboxes: number;
  /** Run bounds (PLAN.md §3.4). Flat columns; `budget()` assembles them. */
  budgetMaxTurns: number;
  budgetMaxCostUsd: number;
  budgetWallClockMs: number;
}

export type SettingsPatch = Partial<StoredSettings>;

/**
 * Persistence seam. `read` returns null when the singleton row has never been
 * written; `write` must upsert.
 */
export interface SettingsRepository {
  read(): Promise<StoredSettings | null>;
  write(patch: SettingsPatch): Promise<void>;
}

export type CredentialName = "githubToken" | "openaiKey";

export const CREDENTIAL_NAMES: readonly CredentialName[] = ["githubToken", "openaiKey"];

/** Everything the browser is allowed to know about a stored credential. */
export interface CredentialSummary {
  present: boolean;
  /** Last 4 characters, or null when unset. */
  hint: string | null;
  /** Ready-to-render mask, e.g. `••••••••4f2a`. Null when unset. */
  masked: string | null;
}

export interface SettingsView {
  githubToken: CredentialSummary;
  openaiKey: CredentialSummary;
  defaultModel: string;
  maxConcurrentSandboxes: number;
  /** The default run bounds every new run is measured against. */
  budget: RunBudget;
}

export const DEFAULT_SETTINGS: StoredSettings = {
  githubTokenEnc: null,
  openaiKeyEnc: null,
  githubTokenHint: null,
  openaiKeyHint: null,
  defaultModel: "gpt-5",
  maxConcurrentSandboxes: 3,
  // Sourced from core so an unsaved settings row and a freshly saved default
  // bound a run identically. Two copies of these numbers is how the ceiling the
  // UI advertises comes to differ from the one the gateway enforces.
  budgetMaxTurns: DEFAULT_BUDGET.maxTurns,
  budgetMaxCostUsd: DEFAULT_BUDGET.maxCostUsd,
  budgetWallClockMs: DEFAULT_BUDGET.wallClockMs,
};

const COLUMNS: Record<CredentialName, { enc: keyof StoredSettings; hint: keyof StoredSettings }> = {
  githubToken: { enc: "githubTokenEnc", hint: "githubTokenHint" },
  openaiKey: { enc: "openaiKeyEnc", hint: "openaiKeyHint" },
};

export class CredentialStore {
  readonly #repo: SettingsRepository;
  readonly #key: EncryptionKey;

  constructor(repo: SettingsRepository, key: EncryptionKey) {
    this.#repo = repo;
    this.#key = key;
  }

  /** Raw row, defaulted. Internal — callers outside want `view()`. */
  async #settings(): Promise<StoredSettings> {
    return (await this.#repo.read()) ?? { ...DEFAULT_SETTINGS };
  }

  /**
   * What the Settings page renders. Contains no ciphertext and no plaintext —
   * safe to serialise straight to the browser.
   */
  async view(): Promise<SettingsView> {
    const row = await this.#settings();
    return {
      githubToken: summarise(isSet(row.githubTokenEnc), row.githubTokenHint),
      openaiKey: summarise(isSet(row.openaiKeyEnc), row.openaiKeyHint),
      defaultModel: row.defaultModel,
      maxConcurrentSandboxes: row.maxConcurrentSandboxes,
      budget: toBudget(row),
    };
  }

  /**
   * The run bounds, without the rest of the view.
   *
   * The gateway calls this once per run rather than caching it, for the same
   * reason it re-reads the API key on every call: a ceiling raised in Settings
   * should take effect on the next run, not on the next worker restart.
   */
  async budget(): Promise<RunBudget> {
    return toBudget(await this.#settings());
  }

  /** True if the credential is set, without decrypting it. */
  async has(name: CredentialName): Promise<boolean> {
    const row = await this.#settings();
    return row[COLUMNS[name].enc] !== null;
  }

  /**
   * Decrypts a credential and registers it for redaction.
   *
   * Returns null when unset. Throws `DecryptionError` when the row exists but
   * cannot be decrypted — which almost always means `APP_ENCRYPTION_KEY`
   * changed, and is a case the caller must surface rather than silently treat
   * as "no credential configured".
   */
  async get(name: CredentialName): Promise<string | null> {
    const row = await this.#settings();
    const envelope = row[COLUMNS[name].enc];
    if (typeof envelope !== "string" || envelope === "") return null;

    const plaintext = decryptSecret(envelope, this.#key);
    registerSecret(plaintext);
    return plaintext;
  }

  /**
   * Encrypts and stores a credential, and records its hint.
   *
   * The value is registered for redaction here too: it arrived from an HTTP
   * request body, so anything that logs the request afterwards must not see it.
   */
  async set(name: CredentialName, plaintext: string): Promise<CredentialSummary> {
    const value = plaintext.trim();
    if (value === "") throw new TypeError(`Refusing to store an empty ${name}.`);
    registerSecret(value);

    const cols = COLUMNS[name];
    await this.#repo.write({
      [cols.enc]: encryptSecret(value, this.#key),
      [cols.hint]: hintOf(value),
    } as SettingsPatch);

    return summarise(true, hintOf(value));
  }

  /** Removes a credential. Clears the hint too, so the UI stops advertising it. */
  async clear(name: CredentialName): Promise<void> {
    const cols = COLUMNS[name];
    await this.#repo.write({ [cols.enc]: null, [cols.hint]: null } as SettingsPatch);
  }

  /** Non-secret preferences living in the same singleton row. */
  async setPreferences(prefs: {
    defaultModel?: string;
    maxConcurrentSandboxes?: number;
    budget?: RunBudget;
  }): Promise<void> {
    const patch: SettingsPatch = {};
    if (prefs.defaultModel !== undefined) patch.defaultModel = prefs.defaultModel;
    if (prefs.maxConcurrentSandboxes !== undefined) {
      patch.maxConcurrentSandboxes = prefs.maxConcurrentSandboxes;
    }
    if (prefs.budget !== undefined) {
      // Written as one unit: a half-applied budget (new turn ceiling, old cost
      // ceiling) is a combination the user never chose.
      patch.budgetMaxTurns = prefs.budget.maxTurns;
      patch.budgetMaxCostUsd = prefs.budget.maxCostUsd;
      patch.budgetWallClockMs = prefs.budget.wallClockMs;
    }
    if (Object.keys(patch).length === 0) return;
    await this.#repo.write(patch);
  }
}

function toBudget(row: StoredSettings): RunBudget {
  return {
    maxTurns: row.budgetMaxTurns,
    maxCostUsd: row.budgetMaxCostUsd,
    wallClockMs: row.budgetWallClockMs,
  };
}

function isSet(envelope: string | null): boolean {
  return envelope !== null && envelope !== "";
}

function summarise(present: boolean, hint: string | null): CredentialSummary {
  return {
    present,
    hint: present ? hint : null,
    masked: present ? maskFromHint(hint) : null,
  };
}

/**
 * In-memory `SettingsRepository`. Used by the unit tests, and useful for a
 * dry run of the Settings page without Postgres.
 */
export function inMemorySettingsRepository(seed: Partial<StoredSettings> = {}): SettingsRepository & {
  snapshot(): StoredSettings;
} {
  let row: StoredSettings = { ...DEFAULT_SETTINGS, ...seed };
  let written = Object.keys(seed).length > 0;
  return {
    async read() {
      return written ? { ...row } : null;
    },
    async write(patch) {
      row = { ...row, ...patch };
      written = true;
    },
    snapshot() {
      return { ...row };
    },
  };
}
