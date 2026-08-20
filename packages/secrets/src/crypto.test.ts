import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DecryptionError,
  ENVELOPE_VERSION,
  EncryptionKeyError,
  decryptSecret,
  encryptSecret,
  hintOf,
  loadEncryptionKey,
  maskFromHint,
} from "./crypto.js";

/**
 * Fixture credentials are randomly generated per run, never real. Nothing in
 * this file may ever contain a token that works anywhere.
 */
function fakeToken(prefix: string): string {
  return `${prefix}${randomBytes(20).toString("hex")}`;
}

function freshKey() {
  return loadEncryptionKey(randomBytes(32).toString("base64"));
}

describe("loadEncryptionKey", () => {
  it("accepts 32 random bytes as base64", () => {
    const key = loadEncryptionKey(randomBytes(32).toString("base64"));
    assert.equal(key.length, 32);
  });

  it("tolerates surrounding whitespace from a copied .env line", () => {
    const raw = randomBytes(32).toString("base64");
    assert.deepEqual(loadEncryptionKey(` ${raw}\n`), loadEncryptionKey(raw));
  });

  it("rejects a missing key with an actionable message", () => {
    assert.throws(() => loadEncryptionKey(undefined), (err: unknown) => {
      assert.ok(err instanceof EncryptionKeyError);
      assert.match((err as Error).message, /APP_ENCRYPTION_KEY/);
      return true;
    });
    assert.throws(() => loadEncryptionKey("   "), EncryptionKeyError);
  });

  it("rejects a key of the wrong length rather than padding it", () => {
    assert.throws(() => loadEncryptionKey(randomBytes(16).toString("base64")), EncryptionKeyError);
    assert.throws(() => loadEncryptionKey(randomBytes(64).toString("base64")), EncryptionKeyError);
  });

  it("refuses a passphrase, so nobody believes a weak one is stretched", () => {
    assert.throws(() => loadEncryptionKey("password123"), EncryptionKeyError);
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a credential exactly", () => {
    const key = freshKey();
    const token = fakeToken("ghp_");
    assert.equal(decryptSecret(encryptSecret(token, key), key), token);
  });

  it("round-trips multi-byte and long values", () => {
    const key = freshKey();
    for (const value of ["sk-proj-" + "a".repeat(400), "clé-secrète-🔐", "x".repeat(1)]) {
      assert.equal(decryptSecret(encryptSecret(value, key), key), value);
    }
  });

  it("uses a fresh IV, so the same plaintext never encrypts alike", () => {
    const key = freshKey();
    const token = fakeToken("ghp_");
    const a = encryptSecret(token, key);
    const b = encryptSecret(token, key);
    assert.notEqual(a, b, "identical ciphertexts mean the IV was reused");
    assert.equal(decryptSecret(a, key), decryptSecret(b, key));
  });

  it("writes a versioned four-part envelope", () => {
    const parts = encryptSecret(fakeToken("ghp_"), freshKey()).split(":");
    assert.equal(parts.length, 4);
    assert.equal(parts[0], ENVELOPE_VERSION);
  });

  it("never embeds the plaintext in the envelope", () => {
    const key = freshKey();
    const token = fakeToken("ghp_");
    assert.ok(!encryptSecret(token, key).includes(token));
  });

  it("refuses to encrypt an empty value", () => {
    assert.throws(() => encryptSecret("", freshKey()), TypeError);
  });

  it("fails on the wrong key instead of returning garbage", () => {
    const envelope = encryptSecret(fakeToken("ghp_"), freshKey());
    assert.throws(() => decryptSecret(envelope, freshKey()), DecryptionError);
  });

  it("detects a tampered ciphertext via the auth tag", () => {
    const key = freshKey();
    const [version, iv, tag, ct] = encryptSecret(fakeToken("ghp_"), key).split(":") as [
      string,
      string,
      string,
      string,
    ];

    const flipped = Buffer.from(ct, "base64");
    flipped[0] ^= 0x01;
    assert.throws(() => decryptSecret([version, iv, tag, flipped.toString("base64")].join(":"), key), DecryptionError);
  });

  it("detects a tampered auth tag", () => {
    const key = freshKey();
    const [version, iv, tag, ct] = encryptSecret(fakeToken("sk-"), key).split(":") as [
      string,
      string,
      string,
      string,
    ];

    const flipped = Buffer.from(tag, "base64");
    flipped[flipped.length - 1] ^= 0xff;
    assert.throws(() => decryptSecret([version, iv, flipped.toString("base64"), ct].join(":"), key), DecryptionError);
  });

  it("detects a tampered IV", () => {
    const key = freshKey();
    const [version, iv, tag, ct] = encryptSecret(fakeToken("sk-"), key).split(":") as [
      string,
      string,
      string,
      string,
    ];

    const flipped = Buffer.from(iv, "base64");
    flipped[0] ^= 0x80;
    assert.throws(() => decryptSecret([version, flipped.toString("base64"), tag, ct].join(":"), key), DecryptionError);
  });

  it("rejects a malformed or wrongly-versioned envelope", () => {
    const key = freshKey();
    assert.throws(() => decryptSecret("not-an-envelope", key), DecryptionError);
    assert.throws(() => decryptSecret("v1:a:b", key), DecryptionError);
    const envelope = encryptSecret(fakeToken("ghp_"), key);
    assert.throws(() => decryptSecret(`v2${envelope.slice(2)}`, key), DecryptionError);
  });

  it("never quotes the input in its error message", () => {
    const key = freshKey();
    const envelope = encryptSecret(fakeToken("ghp_"), key);
    try {
      decryptSecret(envelope, freshKey());
      assert.fail("expected a DecryptionError");
    } catch (err) {
      const message = String(err);
      assert.ok(!message.includes(envelope));
    }
  });
});

describe("hintOf / maskFromHint", () => {
  it("keeps only the last four characters", () => {
    assert.equal(hintOf("ghp_abcdefghijkl9x7Q"), "9x7Q");
    assert.equal(hintOf("sk-proj-ZZZZbeef"), "beef");
  });

  it("does not leak the beginning of the credential", () => {
    const token = fakeToken("ghp_");
    assert.ok(!token.startsWith(hintOf(token)));
    assert.equal(hintOf(token).length, 4);
  });

  it("handles values shorter than the hint length", () => {
    assert.equal(hintOf("ab"), "ab");
  });

  it("renders a mask that ends in the hint", () => {
    assert.equal(maskFromHint("9x7Q"), "••••••••9x7Q");
    assert.equal(maskFromHint(null), null);
    assert.equal(maskFromHint(""), null);
  });
});
