import "server-only";

import { GitHubClient, MirrorManager, createOctokit } from "@codex-clone/github";

import { credentialStore } from "./settings-store";

/**
 * Builds a GitHub client from the credential in the database.
 *
 * A client is constructed per request rather than cached, because the token
 * can be replaced from the Settings page at any moment and a cached Octokit
 * would keep using the old one. Constructing one is cheap; being wrong about
 * which credential is live is not.
 */

export class MissingGithubTokenError extends Error {
  constructor() {
    super("No GitHub token is configured. Add one on the Settings page.");
    this.name = "MissingGithubTokenError";
  }
}

export async function githubClient(): Promise<GitHubClient> {
  const token = await credentialStore().get("githubToken");
  if (!token) throw new MissingGithubTokenError();
  return new GitHubClient(createOctokit(token));
}

/** The PAT, for the host-side git operations that are not API calls. */
export async function githubToken(): Promise<string> {
  const token = await credentialStore().get("githubToken");
  if (!token) throw new MissingGithubTokenError();
  return token;
}

/**
 * Host bare mirrors. `CODEX_DATA_DIR` matches apps/worker/src/config.ts, so
 * both processes address the same directory.
 */
export function mirrorManager(): MirrorManager {
  const dataDir = process.env["CODEX_DATA_DIR"] ?? defaultDataDir();
  return new MirrorManager({ dataDir });
}

function defaultDataDir(): string {
  return `${process.env["HOME"] ?? "."}/.codexclone`;
}
