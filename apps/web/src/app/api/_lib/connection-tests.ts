import "server-only";

import { redact } from "@codex-clone/core";

/**
 * "Test connection" for the two credentials.
 *
 * These run on the server and take the credential as an argument so the token
 * never reaches the browser. Every string that comes back from the provider is
 * passed through `redact()` before it is returned or logged: a 401 body from
 * GitHub can echo request context, and the point of the redaction layer is
 * that we do not have to audit every upstream for that.
 */

export interface ConnectionResult {
  ok: boolean;
  /** Human-readable, redacted. Safe to render. */
  detail: string;
}

const TIMEOUT_MS = 10_000;

export async function testGithubToken(token: string): Promise<ConnectionResult> {
  return probe("GitHub", "https://api.github.com/user", token, {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "codex-clone",
  }, (data) => {
    const login = typeof data["login"] === "string" ? data["login"] : "unknown";
    return `Authenticated as ${login}.`;
  });
}

export async function testOpenAiKey(key: string): Promise<ConnectionResult> {
  return probe("OpenAI", "https://api.openai.com/v1/models", key, {}, (data) => {
    const models = Array.isArray(data["data"]) ? (data["data"] as unknown[]).length : 0;
    return `Key accepted. ${models} model${models === 1 ? "" : "s"} available.`;
  });
}

async function probe(
  provider: string,
  url: string,
  credential: string,
  headers: Record<string, string>,
  describeSuccess: (data: Record<string, unknown>) => string,
): Promise<ConnectionResult> {
  if (credential.trim() === "") {
    return { ok: false, detail: `No ${provider} credential to test.` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { ...headers, Authorization: `Bearer ${credential.trim()}` },
      signal: controller.signal,
      cache: "no-store",
    });

    const body = await response.text();
    if (!response.ok) {
      return { ok: false, detail: redact(failureDetail(provider, response.status, body)) };
    }

    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(body) as Record<string, unknown>;
    } catch {
      // A 200 with an unparseable body still means the credential worked.
    }
    return { ok: true, detail: redact(describeSuccess(data)) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail =
      error instanceof Error && error.name === "AbortError"
        ? `${provider} did not respond within ${TIMEOUT_MS / 1000}s.`
        : `Could not reach ${provider}: ${message}`;
    return { ok: false, detail: redact(detail) };
  } finally {
    clearTimeout(timer);
  }
}

function failureDetail(provider: string, status: number, body: string): string {
  if (status === 401) return `${provider} rejected the credential (401 Unauthorized).`;
  if (status === 403) return `${provider} returned 403 — the credential is valid but lacks permission, or is rate limited.`;

  let message: string | undefined;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const raw = parsed["message"] ?? (parsed["error"] as Record<string, unknown> | undefined)?.["message"];
    if (typeof raw === "string") message = raw;
  } catch {
    // fall through to the bare status
  }
  return `${provider} returned ${status}${message ? `: ${message}` : "."}`;
}
