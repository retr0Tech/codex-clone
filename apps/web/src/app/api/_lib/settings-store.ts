import "server-only";

import { createDb, type Database } from "@codex-clone/db";
import { CredentialStore, drizzleSettingsRepository, loadEncryptionKey } from "@codex-clone/secrets";

import { loadRepoEnv } from "./env";

/**
 * Process-wide singletons for the web app's database handle and credential
 * store.
 *
 * Built lazily rather than at module load: `next build` imports every route
 * module to collect metadata, and a missing DATABASE_URL must fail a request,
 * not the build.
 */

let cachedDb: Database | null = null;
let cachedStore: CredentialStore | null = null;

export function db(): Database {
  loadRepoEnv();
  if (!cachedDb) cachedDb = createDb().db;
  return cachedDb;
}

export function credentialStore(): CredentialStore {
  loadRepoEnv();
  if (!cachedStore) cachedStore = new CredentialStore(drizzleSettingsRepository(db()), loadEncryptionKey());
  return cachedStore;
}

/** Why the settings page cannot be served, phrased for a human to fix. */
export interface ConfigProblem {
  message: string;
}

/**
 * Runs `fn` and converts a configuration failure — no DATABASE_URL, no
 * APP_ENCRYPTION_KEY, migrations not applied — into a value the page can
 * render as a banner instead of a stack trace.
 */
export async function withConfig<T>(fn: (store: CredentialStore) => Promise<T>): Promise<
  { ok: true; value: T } | { ok: false; problem: ConfigProblem }
> {
  try {
    return { ok: true, value: await fn(credentialStore()) };
  } catch (error) {
    return { ok: false, problem: { message: describe(error) } };
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("APP_ENCRYPTION_KEY")) return message;
  if (message.includes("DATABASE_URL")) {
    return "DATABASE_URL is not set. Copy .env.example to .env.local at the repo root.";
  }
  if (/relation .*settings.* does not exist/i.test(message)) {
    return "The database has no schema yet. Run `pnpm db:up && pnpm db:migrate`.";
  }
  if (/ECONNREFUSED|Connection refused/i.test(message)) {
    return "Cannot reach Postgres. Run `pnpm db:up`.";
  }
  return message;
}
