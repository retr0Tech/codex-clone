/**
 * Persistence for discovered repositories.
 *
 * The `repos` table is not a cache of GitHub -- it is the local record that
 * everything else keys off: `tasks.repo_id` is a foreign key into it, and the
 * mirror path and setup script live here because they are properties of our
 * copy, not of the upstream repository.
 *
 * Kept separate from `client.ts` so the API client stays free of a database
 * dependency and can be tested with nothing but a fake Octokit.
 */

import { eq, sql } from "drizzle-orm";
import { repos, type Database } from "@codex-clone/db";

import type { RepoSummary } from "./client.js";

export interface PersistedRepo {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  setupScript: string | null;
  mirrorPath: string | null;
  mirrorFetchedAt: Date | null;
}

/**
 * Upserts the repositories discovered from GitHub.
 *
 * Conflict target is `full_name`, not the primary key: a repository can be
 * renamed or transferred, and matching on the name we actually address it by
 * is what keeps existing tasks pointing at the right row. `setup_script` and
 * the mirror columns are deliberately NOT overwritten -- those are ours, and a
 * repo listing refresh must not wipe a configured install step.
 */
export async function persistRepos(db: Database, summaries: RepoSummary[]): Promise<number> {
  if (summaries.length === 0) return 0;

  for (const summary of summaries) {
    await db
      .insert(repos)
      .values({
        id: summary.id,
        owner: summary.owner,
        name: summary.name,
        fullName: summary.fullName,
        defaultBranch: summary.defaultBranch,
      })
      .onConflictDoUpdate({
        target: repos.fullName,
        set: {
          owner: summary.owner,
          name: summary.name,
          defaultBranch: summary.defaultBranch,
        },
      });
  }

  return summaries.length;
}

/**
 * Most-recently-mirrored first, then alphabetical.
 *
 * `NULLS LAST` is the whole point of this ordering and was missing: Postgres
 * sorts nulls FIRST on a descending sort, so every repository the user had
 * never touched outranked the one they were working in, and the picker opened
 * on a stranger. A mirror exists exactly when we have run a task against that
 * repo, which makes it the best "you were here recently" signal we have.
 */
export async function listPersistedRepos(db: Database): Promise<PersistedRepo[]> {
  const rows = await db
    .select()
    .from(repos)
    .orderBy(sql`${repos.mirrorFetchedAt} desc nulls last`, repos.fullName);
  return rows.map(toPersisted);
}

export async function findRepoByFullName(db: Database, fullName: string): Promise<PersistedRepo | null> {
  const [row] = await db.select().from(repos).where(eq(repos.fullName, fullName)).limit(1);
  return row ? toPersisted(row) : null;
}

/** Records where the bare mirror lives and when it was last fetched. */
export async function recordMirror(
  db: Database,
  fullName: string,
  mirror: { mirrorPath: string; mirrorFetchedAt: Date },
): Promise<void> {
  await db
    .update(repos)
    .set({ mirrorPath: mirror.mirrorPath, mirrorFetchedAt: mirror.mirrorFetchedAt })
    .where(eq(repos.fullName, fullName));
}

/** The per-repo install step, run as its own visible `setup` phase. */
export async function setSetupScript(db: Database, fullName: string, setupScript: string | null): Promise<void> {
  await db.update(repos).set({ setupScript }).where(eq(repos.fullName, fullName));
}

function toPersisted(row: typeof repos.$inferSelect): PersistedRepo {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
    setupScript: row.setupScript,
    mirrorPath: row.mirrorPath,
    mirrorFetchedAt: row.mirrorFetchedAt,
  };
}
