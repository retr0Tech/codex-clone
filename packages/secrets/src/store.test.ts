import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redact } from "@codex-clone/core";

import { DecryptionError, loadEncryptionKey } from "./crypto.js";
import { CredentialStore, inMemorySettingsRepository } from "./store.js";

/** Randomly generated per run. No real credential appears in this repository. */
function fakeToken(prefix: string): string {
  return `${prefix}${randomBytes(20).toString("hex")}`;
}

function freshKey() {
  return loadEncryptionKey(randomBytes(32).toString("base64"));
}

function makeStore() {
  const repo = inMemorySettingsRepository();
  return { repo, store: new CredentialStore(repo, freshKey()) };
}

describe("CredentialStore", () => {
  it("reports an unconfigured store without touching the cipher", async () => {
    const { store } = makeStore();
    const view = await store.view();
    assert.deepEqual(view.githubToken, { present: false, hint: null, masked: null });
    assert.deepEqual(view.openaiKey, { present: false, hint: null, masked: null });
    assert.equal(await store.get("githubToken"), null);
    assert.equal(await store.has("githubToken"), false);
  });

  it("round-trips a stored credential", async () => {
    const { store } = makeStore();
    const token = fakeToken("ghp_");
    await store.set("githubToken", token);
    assert.equal(await store.get("githubToken"), token);
    assert.equal(await store.has("githubToken"), true);
  });

  it("persists ciphertext, never plaintext", async () => {
    const { repo, store } = makeStore();
    const token = fakeToken("ghp_");
    await store.set("githubToken", token);

    const row = repo.snapshot();
    assert.ok(row.githubTokenEnc);
    assert.ok(!row.githubTokenEnc.includes(token));
    assert.ok(!JSON.stringify(row).includes(token));
  });

  it("stores only the last four characters as the hint", async () => {
    const { repo, store } = makeStore();
    const token = fakeToken("ghp_");
    await store.set("githubToken", token);

    assert.equal(repo.snapshot().githubTokenHint, token.slice(-4));
    const view = await store.view();
    assert.equal(view.githubToken.hint, token.slice(-4));
    assert.equal(view.githubToken.masked, `••••••••${token.slice(-4)}`);
  });

  it("builds the masked view without decrypting", async () => {
    // A store holding a row encrypted under a DIFFERENT key can still render
    // the Settings page: the mask comes from the hint column, so the ordinary
    // page load does no cryptography.
    const token = fakeToken("sk-");
    const seeded = inMemorySettingsRepository();
    await new CredentialStore(seeded, freshKey()).set("openaiKey", token);

    const wrongKeyStore = new CredentialStore(seeded, freshKey());
    const view = await wrongKeyStore.view();
    assert.equal(view.openaiKey.present, true);
    assert.equal(view.openaiKey.masked, `••••••••${token.slice(-4)}`);
    // ...but actually reading it does fail, loudly.
    await assert.rejects(() => wrongKeyStore.get("openaiKey"), DecryptionError);
  });

  it("keeps the two credentials independent", async () => {
    const { store } = makeStore();
    const gh = fakeToken("ghp_");
    const oa = fakeToken("sk-");
    await store.set("githubToken", gh);
    await store.set("openaiKey", oa);

    assert.equal(await store.get("githubToken"), gh);
    assert.equal(await store.get("openaiKey"), oa);
  });

  it("overwrites an existing credential and its hint", async () => {
    const { store } = makeStore();
    await store.set("githubToken", fakeToken("ghp_"));
    const replacement = fakeToken("github_pat_");
    await store.set("githubToken", replacement);

    assert.equal(await store.get("githubToken"), replacement);
    assert.equal((await store.view()).githubToken.hint, replacement.slice(-4));
  });

  it("clears a credential and stops advertising a hint", async () => {
    const { store } = makeStore();
    await store.set("openaiKey", fakeToken("sk-"));
    await store.clear("openaiKey");

    assert.equal(await store.get("openaiKey"), null);
    assert.deepEqual((await store.view()).openaiKey, { present: false, hint: null, masked: null });
  });

  it("trims pasted whitespace before encrypting", async () => {
    const { store } = makeStore();
    const token = fakeToken("ghp_");
    await store.set("githubToken", `  ${token}\n`);
    assert.equal(await store.get("githubToken"), token);
  });

  it("refuses to store an empty credential", async () => {
    const { store } = makeStore();
    await assert.rejects(() => store.set("githubToken", "   "), TypeError);
  });

  it("registers the decrypted value for redaction", async () => {
    const { store } = makeStore();
    const token = fakeToken("zzz_"); // no known prefix: only registration can catch it
    await store.set("githubToken", token);

    const decrypted = await store.get("githubToken");
    assert.equal(decrypted, token);
    assert.equal(redact(`git fetch failed for https://x:${token}@github.com/o/r.git`), "git fetch failed for https://x:[REDACTED]@github.com/o/r.git");
  });

  it("registers on write too, so an inbound request body is scrubbed", async () => {
    const { store } = makeStore();
    const token = fakeToken("yyy_");
    await store.set("openaiKey", token);
    assert.equal(redact(`POST /api/settings ${token}`), "POST /api/settings [REDACTED]");
  });

  it("surfaces a key mismatch rather than pretending nothing is configured", async () => {
    const repo = inMemorySettingsRepository();
    await new CredentialStore(repo, freshKey()).set("githubToken", fakeToken("ghp_"));

    const other = new CredentialStore(repo, freshKey());
    assert.equal(await other.has("githubToken"), true);
    await assert.rejects(() => other.get("githubToken"), DecryptionError);
  });

  it("updates non-secret preferences without disturbing credentials", async () => {
    const { store } = makeStore();
    const token = fakeToken("ghp_");
    await store.set("githubToken", token);
    await store.setPreferences({ defaultModel: "gpt-5-mini", maxConcurrentSandboxes: 2 });

    const view = await store.view();
    assert.equal(view.defaultModel, "gpt-5-mini");
    assert.equal(view.maxConcurrentSandboxes, 2);
    assert.equal(await store.get("githubToken"), token);
  });

  it("ignores an empty preferences patch", async () => {
    const { store } = makeStore();
    await store.setPreferences({});
    const view = await store.view();
    assert.equal(view.defaultModel, "gpt-5");
    assert.equal(view.maxConcurrentSandboxes, 3);
  });
});
