# codex-clone

A web-based AI agent coding app: isolated container workspaces backed by GitHub
repositories, with scheduled jobs and a settings-managed credential store.
Local-first, built so agent execution can move to cloud infrastructure without
rewriting the orchestrator.

> **Status.** The loop is closed: you can pick one of your repositories and a
> branch, describe a change, and watch the agent work in an isolated container
> as it happens. What is **not** wired yet is the derived diff view, follow-up
> turns, and pushing a branch or opening a PR — that is milestone 7. See
> [What works today](#what-works-today) for the precise line.

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

Build the agent container image before creating a task — every run needs it:

```bash
pnpm agent:build    # -> codex-clone/agent:dev
```

Then open Settings, paste a GitHub PAT and an OpenAI API key, and you are ready
to create a task.

### Verify your setup

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

Expect **321 tests, 0 failures**, in roughly 15 seconds. Two tests skip unless
`ripgrep` is installed on the host (`brew install ripgrep`); it is baked into
the agent image, so this affects only host-side runs. The Docker- and
Postgres-dependent suites skip with a reason when either is unavailable, and
**no test ever reaches a model provider** — every one of them runs against
`FakeUpstream`, which is the point of having pushed the model call out to the
host in the first place.

Stop `pnpm dev` before running the suite: the run queue is shared through
Postgres, so a live worker and the integration tests will compete for the same
claims.

## What works today

**The main flow works.** Pick a repository and a branch, describe a change,
press Start task, and you land on the task page while the run is still queued:

```
POST /api/tasks ──▶ runs(status=queued)
                         │  FOR UPDATE SKIP LOCKED, at most 3 at a time
                         ▼
   mirror ──▶ host clone at base_sha ──▶ tar(uid 10001) ──▶ ws-<taskId>
                         │
                         ▼
                    container ──NDJSON──▶ events(run_id, seq) ──▶ ws://…:8787
```

A real run against a small repository, streamed live, looks like this — the
host's own lines first, the container's from seq 64 on the stride:

```
+1.4s  seq     1  status      running
+1.4s  seq     2  phase       setup
+1.7s  seq     4  setup_log   refreshed mirror at ~/.codexclone/mirrors/…
+2.0s  seq     7  setup_log   workspace ready
+2.3s  seq   192  phase       agent
+5.3s  seq   256  tool_call   grep {"pattern":"package.json",…}
+10.9s seq   384  tool_call   apply_patch {"patch":"*** Begin Patch…
+13.3s              (39 token deltas — overlay only, never persisted)
+13.9s seq   512  message     "I added CONTRIBUTING.md at the repository root…"
+13.9s seq   704  status      succeeded
```

- **Settings** (`/settings`) — save a GitHub PAT and an OpenAI API key. They are
  encrypted with AES-256-GCM before they touch the database, displayed only as a
  masked hint, and never sent back to the browser. "Test connection" validates
  each against the live provider.
- **GitHub integration** — your repositories and their branches, listed from the
  real API and cached in Postgres.
- **The run queue** — tasks queue in Postgres and are claimed with
  `FOR UPDATE SKIP LOCKED`, at most three containers at a time. Queued work
  reads as `queued` rather than appearing hung, and a worker restart reconciles
  against Docker instead of orphaning containers.
- **The live transcript** — the task page folds history over HTTP, then connects
  to the worker's WebSocket and resumes from the last seq it holds. Reconnects,
  reloads and several tabs on one task all work; token deltas stream as an
  overlay and are discarded the moment the durable message lands.
- **Cancel** — closes the gateway meter first, so no further model call is
  admitted even mid-turn, then SIGTERMs with a grace period. Partial work
  survives, because the workspace volume is the live state.
- **`/mock/transcript`** — replays a recorded run through the same reducer the
  socket feeds, including cancellation, budget exhaustion, and a failed setup
  script. Useful for seeing states a happy run does not produce.

**Not wired yet:** the derived diff (the host running `git diff <baseSha>` after
each turn), follow-up turns against the warm workspace, and pushing a branch or
opening a PR. That is milestone 7. The Diff tab renders, but nothing emits a
`diff` event into it yet.

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
from `GET /api/tasks/:id/events` are the identical `{seq, type, payload}` shape
— literally built by the same function in `@codex-clone/db` — so one client
reducer serves both and they cannot drift. The page proves it on every load: it
folds history over HTTP, then connects the socket with `after=<lastSeq>` and
carries on with the same reducer. Token deltas are the single, named exception
to "everything broadcast is also persisted", and they are dropped the instant
the durable `message` arrives, so a reload can never resurrect a half-typed
sentence.

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
