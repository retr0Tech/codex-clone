import { NextResponse } from "next/server";

import { listPersistedRepos, persistRepos } from "@codex-clone/github";

import { MissingGithubTokenError, githubClient } from "../_lib/github";
import { db } from "../_lib/settings-store";

/**
 * Repository list for the repo picker.
 *
 *   GET /api/repos            -> the locally persisted list, cheap
 *   GET /api/repos?refresh=1  -> re-read from GitHub, upsert, then return
 *
 * The default is the local list because the picker opens on every task
 * creation and GitHub's rate limit is a shared resource. A refresh is an
 * explicit act, plus an automatic one the first time when nothing is stored
 * yet -- an empty picker on first run would look like a bug.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const refreshRequested = new URL(request.url).searchParams.get("refresh") === "1";

  try {
    const database = db();
    let persisted = await listPersistedRepos(database);
    let refreshed = false;

    if (refreshRequested || persisted.length === 0) {
      const client = await githubClient();
      const discovered = await client.listRepositories();
      await persistRepos(database, discovered);
      persisted = await listPersistedRepos(database);
      refreshed = true;
      console.log(`[repos] refreshed ${discovered.length} repositories from GitHub`);
    }

    return NextResponse.json({ refreshed, repos: persisted });
  } catch (error) {
    if (error instanceof MissingGithubTokenError) {
      return NextResponse.json({ error: error.message, repos: [] }, { status: 412 });
    }
    return NextResponse.json({ error: message(error) }, { status: 502 });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
