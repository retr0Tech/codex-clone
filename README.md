# codex-clone

A web-based AI agent coding app: isolated container workspaces backed by GitHub repos,
with scheduled jobs and a settings-managed credential store. Local-first, built so agent
execution can move to cloud infrastructure without rewriting the orchestrator.

> **Status: commit 0 — scaffold and frozen contracts.**
> The shared interfaces, event-type union, and full database schema are in place;
> feature milestones land per [`PLAN.md`](./PLAN.md) §4. Nothing runs end to end yet.

## Architecture at a glance

```
  browser
    │  HTTP (pages, REST)        ws://127.0.0.1:8787 (events)
    ▼                                     │
  web  ── Next.js 15, stock App Router ───┼──────────┐
    │                                     │          │
    ▼                                     ▼          ▼
  postgres  ◄──────────────────────────  worker ── model-gateway
                                           │         (holds the OpenAI key)
                                           │ dockerode
                                           ▼
                                     agent container
                                     (zero credentials)
```

Three properties worth stating up front, because they shaped everything else:

- **The sandbox holds no credentials.** The host clones and pushes on the agent's
  behalf, so no GitHub token enters the container; model calls go through a host
  gateway over a bind-mounted unix socket, so no OpenAI key does either.
- **The diff is derived, not reported.** After every turn the host runs
  `git diff <baseSha>` in the workspace volume. The diff view shows reality, never
  the agent's account of it.
- **Live and replayed transcripts are the same data.** A WebSocket frame and a row
  from the history endpoint are the identical `{seq, type, payload}` shape, so one
  client reducer serves both and they cannot drift.

Full reasoning, including the decisions rejected and the risks knowingly accepted,
is in [`PLAN.md`](./PLAN.md).

## Requirements

- macOS
- Node 22+ (`nvm install 22`)
- pnpm 9 (`corepack enable`)
- Docker Desktop, running **under the account you develop from**

## Setup

```bash
corepack enable
pnpm install

cp .env.example .env.local
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # -> APP_ENCRYPTION_KEY
```

Set `DOCKER_SOCKET` in `.env.local` to your own socket:

```bash
echo "$HOME/.docker/run/docker.sock"
```

Docker Desktop creates a **per-user** socket. If another macOS account installed
Docker first, `/var/run/docker.sock` is a symlink into that user's home directory and
is not readable by you — which is why the socket path is configured explicitly rather
than assumed.

Then bring up the database and run migrations:

```bash
pnpm db:up
pnpm db:migrate
pnpm dev          # web on :3000, worker on :8787
```

## Credentials

The GitHub PAT and OpenAI API key are **not** environment variables. They are entered
in the Settings page and stored AES-256-GCM encrypted in Postgres, keyed by
`APP_ENCRYPTION_KEY`. The UI only ever displays a masked hint, and a redaction filter
scrubs registered secret values from all log output. Nothing sensitive is committed.

## Layout

| Path | Purpose |
|---|---|
| `apps/web` | Next.js 15 UI and REST API |
| `apps/worker` | Container lifecycle, event log, WebSocket hub, scheduler, model gateway |
| `packages/core` | Frozen contracts: `SandboxProvider`, `SnapshotStore`, event union, budgets, redaction |
| `packages/db` | Drizzle schema, migrations, client |

## What is not built yet

Every milestone after commit 0. See [`PLAN.md`](./PLAN.md) §4 for the sequence and §5
for the cut order if time runs short.
