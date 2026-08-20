import { NextResponse } from "next/server";

import { findRepoByFullName } from "@codex-clone/github";

import { MissingGithubTokenError, githubClient } from "../../../../_lib/github";
import { db } from "../../../../_lib/settings-store";

/**
 * Branches for one repository, for the base-branch picker.
 *
 * Also returns the default branch so the UI can preselect it, and each
 * branch's head SHA — a task pins `tasks.base_sha` at creation and derives
 * every diff against that pin, so the picker already has the value it needs
 * and task creation does not have to make a second round trip.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ owner: string; name: string }> }) {
  const { owner, name } = await params;

  try {
    const client = await githubClient();
    const [branches, persisted] = await Promise.all([
      client.listBranches(owner, name),
      findRepoByFullName(db(), `${owner}/${name}`),
    ]);

    // Prefer the locally recorded default; fall back to GitHub if this repo
    // has not been persisted yet.
    const defaultBranch =
      persisted?.defaultBranch ?? (await client.getRepository(owner, name)).defaultBranch;

    return NextResponse.json({ repo: `${owner}/${name}`, defaultBranch, branches });
  } catch (error) {
    if (error instanceof MissingGithubTokenError) {
      return NextResponse.json({ error: error.message, branches: [] }, { status: 412 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
