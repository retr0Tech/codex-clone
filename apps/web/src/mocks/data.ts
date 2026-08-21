/**
 * Repos and tasks, for `/mock/transcript`.
 *
 * The scheduled-job fixtures that used to live here are gone: `/scheduled`
 * reads real rows now, and a fixture nothing renders is a lie waiting to be
 * mistaken for a feature.
 *
 * Shapes mirror `packages/db/src/schema.ts` so that replacing these arrays with
 * a Drizzle query is a one-line change per view. Dates are ISO strings, as they
 * will be over the REST boundary.
 */

export interface MockRepo {
  id: string;
  fullName: string;
  defaultBranch: string;
  branches: string[];
  setupScript: string;
}

export interface MockTask {
  id: string;
  repoId: string;
  title: string;
  mode: "ask" | "code";
  baseBranch: string;
  baseSha: string;
  workBranch: string | null;
  status: "idle" | "queued" | "running" | "archived";
  lastActivityAt: string;
  createdAt: string;
  archivedAt: string | null;
  /** Denormalised for the list rows; the API will return these alongside. */
  summary: string;
  additions: number;
  deletions: number;
  filesChanged: number;
}

export const mockRepos: MockRepo[] = [
  {
    id: "repo_atlas",
    fullName: "retr0Tech/atlas-api",
    defaultBranch: "main",
    branches: ["main", "release/2.4", "feat/webhooks", "chore/deps"],
    setupScript: "pnpm install --frozen-lockfile",
  },
  {
    id: "repo_ledger",
    fullName: "retr0Tech/ledger",
    defaultBranch: "main",
    branches: ["main", "next", "hotfix/invoice-rounding"],
    setupScript: "uv sync --frozen",
  },
  {
    id: "repo_console",
    fullName: "retr0Tech/console",
    defaultBranch: "main",
    branches: ["main", "design-system"],
    setupScript: "npm ci",
  },
];

export const mockTasks: MockTask[] = [
  {
    id: "task_rate_limit",
    repoId: "repo_atlas",
    title: "Add rate limiting to the public API",
    mode: "code",
    baseBranch: "main",
    baseSha: "a41f0c9d3b6e2f7148ac55d90b2e1c8f4a7d3e12",
    workBranch: "codex/rate-limit-public-api",
    status: "idle",
    lastActivityAt: "2026-08-19T09:33:12.000Z",
    createdAt: "2026-08-19T09:14:00.000Z",
    archivedAt: null,
    summary: "Redis-backed fixed window at 120 req/min/IP, with tests.",
    additions: 83,
    deletions: 3,
    filesChanged: 4,
  },
  {
    id: "task_migrate_orm",
    repoId: "repo_ledger",
    title: "Migrate SQLAlchemy models to the 2.0 typed style",
    mode: "code",
    baseBranch: "main",
    baseSha: "7d2e91b04c8a5f36e1290bd47ac6f5138e0b92aa",
    workBranch: "codex/sqlalchemy-2-typed",
    status: "idle",
    lastActivityAt: "2026-08-19T14:04:51.000Z",
    createdAt: "2026-08-19T14:02:09.000Z",
    archivedAt: null,
    summary: "Cancelled after the first module failed its relationship tests.",
    additions: 41,
    deletions: 38,
    filesChanged: 1,
  },
  {
    id: "task_flaky_suite",
    repoId: "repo_console",
    title: "Find and fix the flaky queue test",
    mode: "code",
    baseBranch: "main",
    baseSha: "1c0aa73f9de2b845c7f31e6a0b4d2985cf7a1130",
    workBranch: null,
    status: "idle",
    lastActivityAt: "2026-08-18T21:47:19.000Z",
    createdAt: "2026-08-18T21:40:50.000Z",
    archivedAt: null,
    summary: "Diagnosed module-level timer state, then hit the cost ceiling.",
    additions: 0,
    deletions: 0,
    filesChanged: 0,
  },
  {
    id: "task_bump_node",
    repoId: "repo_atlas",
    title: "Bump to Node 22 and update the CI matrix",
    mode: "code",
    baseBranch: "chore/deps",
    baseSha: "b83c1f24ea9075d6318bf40c2ed579a16b3c8842",
    workBranch: null,
    status: "idle",
    lastActivityAt: "2026-08-18T08:04:12.000Z",
    createdAt: "2026-08-18T08:03:40.000Z",
    archivedAt: null,
    summary: "Setup script failed — lockfile out of date, no tokens spent.",
    additions: 0,
    deletions: 0,
    filesChanged: 0,
  },
  {
    id: "task_explain_billing",
    repoId: "repo_ledger",
    title: "Explain how proration is calculated on plan change",
    mode: "ask",
    baseBranch: "main",
    baseSha: "7d2e91b04c8a5f36e1290bd47ac6f5138e0b92aa",
    workBranch: null,
    status: "idle",
    lastActivityAt: "2026-08-17T16:22:03.000Z",
    createdAt: "2026-08-17T16:19:44.000Z",
    archivedAt: null,
    summary: "Ask mode — read-only workspace, no apply_patch tool.",
    additions: 0,
    deletions: 0,
    filesChanged: 0,
  },
  {
    id: "task_queued_indexes",
    repoId: "repo_atlas",
    title: "Add covering indexes for the usage rollup query",
    mode: "code",
    baseBranch: "main",
    baseSha: "a41f0c9d3b6e2f7148ac55d90b2e1c8f4a7d3e12",
    workBranch: null,
    status: "queued",
    lastActivityAt: "2026-08-20T07:58:30.000Z",
    createdAt: "2026-08-20T07:58:30.000Z",
    archivedAt: null,
    summary: "Waiting for a sandbox slot — 3 containers already running.",
    additions: 0,
    deletions: 0,
    filesChanged: 0,
  },
];

export const mockArchivedTasks: MockTask[] = [
  {
    id: "task_webhook_retry",
    repoId: "repo_atlas",
    title: "Exponential backoff for webhook delivery",
    mode: "code",
    baseBranch: "main",
    baseSha: "5f7b21ca03d94e618a2c7fd0be3419852ad60c77",
    workBranch: "codex/webhook-backoff",
    status: "archived",
    lastActivityAt: "2026-08-11T11:02:40.000Z",
    createdAt: "2026-08-11T10:44:12.000Z",
    archivedAt: "2026-08-12T09:00:00.000Z",
    summary: "Merged as #418. Snapshot retained.",
    additions: 137,
    deletions: 22,
    filesChanged: 6,
  },
  {
    id: "task_drop_legacy",
    repoId: "repo_ledger",
    title: "Drop the legacy v0 invoice endpoints",
    mode: "code",
    baseBranch: "main",
    baseSha: "cc19402ba7de3861f5027e94a1b6d3820ef5471c",
    workBranch: "codex/drop-v0-invoices",
    status: "archived",
    lastActivityAt: "2026-08-06T15:31:07.000Z",
    createdAt: "2026-08-06T15:12:55.000Z",
    archivedAt: "2026-08-08T18:20:00.000Z",
    summary: "Abandoned — blocked on a consumer still on v0.",
    additions: 4,
    deletions: 612,
    filesChanged: 11,
  },
  {
    id: "task_docs_pass",
    repoId: "repo_console",
    title: "Rewrite the component docs for the design system",
    mode: "code",
    baseBranch: "design-system",
    baseSha: "9a0c33e17f4b2856d1e0742ba5cf3968e2d17b04",
    workBranch: "codex/design-system-docs",
    status: "archived",
    lastActivityAt: "2026-07-29T13:14:22.000Z",
    createdAt: "2026-07-29T12:40:03.000Z",
    archivedAt: "2026-07-30T08:12:00.000Z",
    summary: "Superseded by the Storybook migration.",
    additions: 890,
    deletions: 410,
    filesChanged: 34,
  },
];

export function repoById(id: string): MockRepo | undefined {
  return mockRepos.find((r) => r.id === id);
}

export function taskById(id: string): MockTask | undefined {
  return [...mockTasks, ...mockArchivedTasks].find((t) => t.id === id);
}
