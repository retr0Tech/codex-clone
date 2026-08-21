/**
 * Where the gateway gets the OpenAI key.
 *
 * The real implementation is the AES-256-GCM credential store landing in
 * milestone 1 (wave A, in flight in parallel). The gateway depends on this
 * one-method interface rather than on that module, so neither wave blocks the
 * other and the swap is a single line in worker startup.
 */
export interface CredentialStore {
  /** Null when the user has not configured a key yet -- not an error. */
  getOpenAiKey(): Promise<string | null>;
}

/**
 * TEMPORARY -- replace with the encrypted store from milestone 1.
 *
 * Reads OPENAI_API_KEY from the worker's own environment. This is explicitly
 * NOT the shipping design: PLAN.md section 3.3 puts credentials AES-256-GCM
 * encrypted in Postgres, entered through the Settings page, with only
 * APP_ENCRYPTION_KEY in the environment. This exists so the gateway is
 * runnable and testable before wave A merges.
 *
 * Note the key never leaves the worker process either way: it is attached to
 * the outbound request here and is never written to a container, a log line,
 * or an event payload.
 */
export class EnvCredentialStore implements CredentialStore {
  constructor(private readonly varName = "OPENAI_API_KEY") {}

  getOpenAiKey(): Promise<string | null> {
    const value = process.env[this.varName];
    return Promise.resolve(value && value.trim() !== "" ? value : null);
  }
}

/** For tests and for a gateway that should refuse every call. */
export class StaticCredentialStore implements CredentialStore {
  constructor(private readonly key: string | null) {}

  getOpenAiKey(): Promise<string | null> {
    return Promise.resolve(this.key);
  }
}
