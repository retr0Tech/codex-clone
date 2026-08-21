import type { RunBudget } from "@codex-clone/core";
import type { Database } from "@codex-clone/db";
import {
  CredentialStore as EncryptedStore,
  drizzleSettingsRepository,
  loadEncryptionKey,
} from "@codex-clone/secrets";
import type { CredentialStore } from "./gateway/credentials.js";

/**
 * The shipping credential seam: the gateway's OpenAI key comes from the
 * AES-256-GCM store in Postgres, not from the worker's environment.
 *
 * This replaces `EnvCredentialStore` (milestone 4's temporary stand-in). The
 * key is entered on the Settings page, encrypted at rest with
 * `APP_ENCRYPTION_KEY`, and decrypted here per request rather than cached, for
 * the same reason the web app builds a fresh Octokit per request: a key the
 * user just replaced in Settings must take effect on the next model call, and
 * a cached plaintext would keep a revoked credential alive in memory for the
 * lifetime of the process.
 *
 * `packages/secrets` registers every decrypted value with the redacting logger
 * on the way out, so from the first moment the key exists in this process it is
 * scrubbed from anything written to a log line or an event payload.
 */
export class EncryptedCredentialStore implements CredentialStore {
  readonly #store: EncryptedStore;

  constructor(store: EncryptedStore) {
    this.#store = store;
  }

  /** Builds the store from a database handle and APP_ENCRYPTION_KEY. */
  static fromDatabase(db: Database): EncryptedCredentialStore {
    return new EncryptedCredentialStore(
      new EncryptedStore(drizzleSettingsRepository(db), loadEncryptionKey()),
    );
  }

  /**
   * Null when no key is configured -- that is a normal state on first run, and
   * the gateway turns it into a `refused` chunk telling the user to visit
   * Settings, rather than into an exception nobody sees.
   */
  getOpenAiKey(): Promise<string | null> {
    return this.#store.get("openaiKey");
  }

  /**
   * The PAT, for the host-side git and API calls. It never reaches a container:
   * every credentialed GitHub operation happens in the worker process.
   */
  getGithubToken(): Promise<string | null> {
    return this.#store.get("githubToken");
  }

  /** Non-secret preferences that live in the same singleton row. */
  async defaultModel(): Promise<string> {
    return (await this.#store.view()).defaultModel;
  }

  /**
   * The run bounds, read per run for the same reason the key is read per call:
   * a ceiling raised in Settings must take effect on the next run rather than
   * on the next restart of this process.
   */
  runBudget(): Promise<RunBudget> {
    return this.#store.budget();
  }
}
