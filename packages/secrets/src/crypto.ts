/**
 * AES-256-GCM for credentials at rest (PLAN.md §3.3).
 *
 * GCM rather than CBC because the credential store must detect tampering: a
 * flipped byte in `github_token_enc` should fail loudly, not decrypt into
 * garbage that we then send to api.github.com. The auth tag gives us that for
 * free, so `decryptSecret` either returns the exact original plaintext or
 * throws.
 *
 * Nothing in this module ever puts plaintext, ciphertext or key material into
 * an Error message. A stack trace is not a safe place for a credential.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
/** 96-bit nonce: the size GCM is specified for, and the fastest path. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Envelope version prefix. Stored with every ciphertext so a future key
 * rotation or algorithm change can be detected rather than guessed at.
 */
export const ENVELOPE_VERSION = "v1";

/** Length of the `*_hint` columns: enough to recognise, useless to an attacker. */
export const HINT_LENGTH = 4;

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionKeyError";
  }
}

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

/**
 * Opaque key handle. It is a branded Buffer rather than a bare one so a key
 * cannot be passed where a plaintext string is expected, and so `console.log`
 * of a config object shows `<Buffer ...>` rather than the base64 secret.
 */
export type EncryptionKey = Buffer & { readonly __brand: "EncryptionKey" };

/**
 * Derives the data key from `APP_ENCRYPTION_KEY`.
 *
 * The env var is required to be 32 random bytes, base64. We deliberately do
 * NOT accept a passphrase and stretch it with PBKDF2/scrypt: that invites
 * users to type "password123" and believe it is safe. Refusing anything that
 * is not full-entropy key material is the honest failure.
 */
export function loadEncryptionKey(raw: string | undefined = process.env.APP_ENCRYPTION_KEY): EncryptionKey {
  if (!raw || raw.trim() === "") {
    throw new EncryptionKeyError(
      "APP_ENCRYPTION_KEY is not set. Generate one with: " +
        `node -e "console.log(require('crypto').randomBytes(${KEY_BYTES}).toString('base64'))"`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(raw.trim(), "base64");
  } catch {
    throw new EncryptionKeyError("APP_ENCRYPTION_KEY is not valid base64.");
  }

  if (bytes.length !== KEY_BYTES) {
    throw new EncryptionKeyError(
      `APP_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes, got ${bytes.length}.`,
    );
  }

  return bytes as EncryptionKey;
}

/**
 * Encrypts one credential.
 *
 * Envelope: `v1:<iv>:<tag>:<ciphertext>`, all base64. The IV is fresh per call
 * — reusing a nonce under GCM is a catastrophic break, so it is generated here
 * and never accepted from a caller.
 */
export function encryptSecret(plaintext: string, key: EncryptionKey): string {
  if (plaintext === "") throw new TypeError("Refusing to encrypt an empty credential.");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [ENVELOPE_VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

/**
 * Decrypts one credential, or throws `DecryptionError`.
 *
 * A wrong key and a tampered ciphertext are indistinguishable here by design:
 * both are "the auth tag did not verify". The message never quotes the input.
 */
export function decryptSecret(envelope: string, key: EncryptionKey): string {
  const parts = envelope.split(":");
  if (parts.length !== 4) {
    throw new DecryptionError("Malformed credential envelope.");
  }

  const [version, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  if (version !== ENVELOPE_VERSION) {
    throw new DecryptionError(`Unsupported credential envelope version: ${version}`);
  }

  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");

  if (iv.length !== IV_BYTES) throw new DecryptionError("Malformed credential envelope: bad IV length.");
  if (tag.length !== TAG_BYTES) throw new DecryptionError("Malformed credential envelope: bad auth tag length.");

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key, tampered ciphertext, tampered IV or tampered tag all land
    // here. Do not leak which -- and do not echo any of the inputs.
    throw new DecryptionError("Could not decrypt credential: wrong encryption key, or the stored value was altered.");
  }
}

/**
 * The value stored in the `*_hint` columns.
 *
 * Last four characters only. That is enough for a user to confirm "yes, that
 * is the token I pasted" and lets the Settings page render a mask WITHOUT
 * decrypting anything — the common page load never touches the cipher at all.
 */
export function hintOf(plaintext: string): string {
  return plaintext.slice(-HINT_LENGTH);
}

/**
 * Display form built from a stored hint.
 *
 * `maskSecret` in @codex-clone/core is the equivalent for a value you already
 * hold in full; this is its counterpart for the hint-only path, and matches
 * its trailing shape so the two render identically.
 */
export function maskFromHint(hint: string | null | undefined): string | null {
  if (!hint) return null;
  return `${"•".repeat(8)}${hint}`;
}
