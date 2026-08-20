import { NextResponse } from "next/server";

import { testGithubToken, testOpenAiKey } from "../../_lib/connection-tests";
import { credentialStore } from "../../_lib/settings-store";

/**
 * "Test connection".
 *
 * The probe runs here, on the server, so the credential is never handed to the
 * browser to test with. Two sources are supported:
 *
 *   { provider, value } -> test what the user just typed, before saving
 *   { provider }        -> test what is already stored
 *
 * The response says whether it worked and why not; it never echoes the
 * credential, and every provider string is redacted on the way out.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TestBody {
  provider?: "github" | "openai";
  value?: string;
}

export async function POST(request: Request) {
  let body: TestBody;
  try {
    body = (await request.json()) as TestBody;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const provider = body.provider;
  if (provider !== "github" && provider !== "openai") {
    return NextResponse.json({ error: "provider must be 'github' or 'openai'." }, { status: 400 });
  }

  try {
    const name = provider === "github" ? "githubToken" : "openaiKey";
    const typed = typeof body.value === "string" ? body.value.trim() : "";
    const credential = typed !== "" ? typed : await credentialStore().get(name);

    if (!credential) {
      return NextResponse.json({
        ok: false,
        detail: `No ${provider === "github" ? "GitHub token" : "OpenAI API key"} is configured yet.`,
      });
    }

    const result = provider === "github" ? await testGithubToken(credential) : await testOpenAiKey(credential);
    console.log(`[settings] connection test ${provider}: ${result.ok ? "ok" : "failed"}`);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
