/**
 * Credential redaction, applied at the logging boundary everywhere.
 *
 * The brief requires that secrets are not "exposed unnecessarily in logs or
 * the user interface". Pattern matching alone is not sufficient -- it cannot
 * know about a token it has never seen a prefix for -- so registered live
 * secret VALUES are redacted too. Register every credential at the moment it
 * is decrypted.
 */

const KNOWN_SECRET_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub PAT (classic + fine-grained prefixes)
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI
  /\bBearer\s+[A-Za-z0-9._-]{20,}/gi,
];

const liveSecrets = new Set<string>();

/**
 * Register a decrypted secret so its literal value is scrubbed from all
 * subsequent output, regardless of shape.
 */
export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 8) liveSecrets.add(value);
}

export function forgetSecret(value: string): void {
  liveSecrets.delete(value);
}

export function redact(input: string): string {
  let out = input;
  for (const secret of liveSecrets) {
    out = out.split(secret).join("[REDACTED]");
  }
  for (const pattern of KNOWN_SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/** Deep-redacts a structure before it is logged or sent to a client. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

/** Display form for the UI. Never send a full credential to the browser. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}${"•".repeat(8)}${value.slice(-4)}`;
}
