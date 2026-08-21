# codex-clone

A web-based AI agent coding app: isolated container workspaces backed by GitHub
repositories, with scheduled jobs and a settings-managed credential store.
Local-first, built so agent execution can move to cloud infrastructure without
rewriting the orchestrator.

> **Status.** The platform layer is complete and tested: credential store,
> GitHub integration, container sandbox, in-container agent runtime, host model
> gateway, and the full UI. **The end-to-end loop is not wired yet** — you
> cannot yet create a task and watch an agent edit a real repository. See
> [What works today](#what-works-today) for the precise line, and
> [`PLAN.md`](./PLAN.md) §4 for the remaining milestones.

## Requirements

| | |
|---|---|
| macOS | the only supported host |
| Node 22+ | `nvm install 22` |
| pnpm 9 | `corepack enable` |
| Docker Desktop | must be running **under the account you develop from** |

## Quick start

```bash
corepack enable
pnpm install

cp .env.example .env.local
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# paste the output into APP_ENCRYPTION_KEY in .env.local

pnpm db:up          # Postgres in Docker, bound to 127.0.0.1
pnpm db:migrate     # create the schema
pnpm dev            # web on :3000, worker on :8787
```

Open <http://localhost:3000>. `APP_ENCRYPTION_KEY` is the only value you must
fill in; everything else in `.env.example` has a working default. Both the web
app and the worker read that single root `.env.local`.

To build the agent container image (needed only once the run loop lands, but it
is what the sandbox tests exercise):

```bash
pnpm agent:build    # -> codex-clone/agent:dev
```

### Verify your setup

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

Expect **266 tests, 0 failures**, in roughly 10 seconds. Two tests skip unless
`ripgrep` is installed on the host (`brew install ripgrep`); it is baked into
the agent image, so this affects only host-side runs.

## What works today

**You can exercise now:**

- **Settings** (`/settings`) — save a GitHub PAT and an OpenAI API key. They are
  encrypted with AES-256-GCM before they touch the database, displayed only as a
  masked hint, and never sent back to the browser. "Test connection" validates
  each against the live provider.
- **GitHub integration** — your repositories and their branches, listed from the
  real API and cached in Postgres.
- **The full UI** — sidebar, task composer, task detail, archived and scheduled
  views.
- **`/mock/transcript`** — replays a recorded agent run with realistic
  streaming: setup phase, reasoning, tool calls, a diff, completion. Also covers
  cancellation, budget exhaustion, and a failed setup script. This is the
  clearest picture of the intended experience.
- **The platform layer, under test** — container sandbox with its isolation
  properties, the agent runtime, and the model gateway.

**Not wired yet:** creating a task and watching a real agent work. Every piece
exists and is tested independently; nothing yet connects a task to a running
container. That is milestone 5 (queue → clone → run), 6 (live transcript over
WebSocket), and 7 (diff, push branch, open PR).

## Architecture

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

Three properties shaped everything else:

**The sandbox holds no credentials.** The host clones and pushes on the agent's
behalf, so no GitHub token enters the container; model calls go through a host
gateway over a bind-mounted unix socket, so no OpenAI key does either. A
prompt-injected agent has nothing to exfiltrate.

**The diff is derived, not reported.** After every turn the host runs
`git diff <baseSha>` in the workspace volume. The diff view shows what actually
changed, never the agent's account of it. Ask mode is enforced the same way —
the tool list omits `apply_patch` and the workspace mounts read-only, so a
jailbroken agent still cannot write.

**Live and replayed transcripts are the same data.** A WebSocket frame and a row
from the history endpoint are the identical `{seq, type, payload}` shape, so one
client reducer serves both and they cannot drift.

Containers run non-root with all capabilities dropped, `no-new-privileges`, a
read-only root filesystem, and memory/CPU/pid limits. Full reasoning — including
the options rejected and the risks knowingly accepted — is in
[`PLAN.md`](./PLAN.md).

## Layout

| Path | Purpose |
|---|---|
| `apps/web` | Next.js UI and REST API |
| `apps/worker` | Container lifecycle, event log, WebSocket hub, scheduler, model gateway |
| `apps/agent-runtime` | The agent loop that runs **inside** the container |
| `packages/core` | Frozen contracts: `SandboxProvider`, `SnapshotStore`, event union, budgets, redaction |
| `packages/sandbox-docker` | Docker implementation of `SandboxProvider` |
| `packages/secrets` | AES-256-GCM credential store |
| `packages/github` | Octokit client and host-side bare-repo mirrors |
| `packages/db` | Drizzle schema, migrations, client |

## Credentials

The GitHub PAT and OpenAI key are **not** environment variables. They are
entered in Settings and stored encrypted in Postgres, keyed by
`APP_ENCRYPTION_KEY`. Decrypted values are registered with a redaction filter
that scrubs them from all log output. Nothing sensitive is committed.

The worker's model gateway reads the OpenAI key from that same encrypted store
on every call rather than caching it, so replacing the key in Settings takes
effect on the next model call instead of on the next restart.

## Troubleshooting

**`Missing required env var: APP_ENCRYPTION_KEY`** — `.env.local` is missing or
the key is blank. It must live at the repository root, not in `apps/`.

**`connect ENOENT .../docker.sock`** — Docker Desktop is not running, or it was
installed under a different macOS account. Docker creates a *per-user* socket;
`/var/run/docker.sock` may symlink into another user's home and be unreadable.
Point `DOCKER_SOCKET` at `$HOME/.docker/run/docker.sock`.

**Database connection refused** — run `pnpm db:up` and give Postgres a few
seconds; the container has a healthcheck.

## Development

```bash
pnpm dev            # web + worker together
pnpm test           # full suite
pnpm db:generate    # after editing packages/db/src/schema.ts
pnpm db:down        # stop Postgres
```
