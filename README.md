# codex-clone

A web-based AI agent coding app: isolated container workspaces backed by GitHub
repositories, with scheduled jobs and a settings-managed credential store.
Local-first, built so agent execution can move to cloud infrastructure without
rewriting the orchestrator.

> **Status.** The vertical slice is complete. Pick one of your repositories and
> a branch, describe a change, and watch reasoning, tool calls and a real diff
> stream in live — then push the branch and open a pull request, all from the
> host. See [The end-to-end flow](#the-end-to-end-flow) to follow it yourself,
> and [What works today](#what-works-today) for what is and is not built.

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

Expect **346 tests, 0 failures**, in roughly 20 seconds. Two tests skip unless
`ripgrep` is installed on the host (`brew install ripgrep`); it is baked into
the agent image, so this affects only host-side runs. The Docker- and
Postgres-dependent suites skip with a reason when either is unavailable, and
**no test ever reaches a model provider** — every one of them runs against
`FakeUpstream`, which is the point of having pushed the model call out to the
host in the first place.

Stop `pnpm dev` before running the suite: the run queue is shared through
Postgres, so a live worker and the integration tests will compete for the same
claims.

## The end-to-end flow

What actually happens between pressing "Start task" and having a pull request,
and which process does each part:

```
 browser   POST /api/tasks {repo, branch, prompt}
    │        └─ web resolves the branch to a SHA and pins tasks.base_sha
    ▼           (a client-supplied SHA is never accepted: every diff is
 postgres        measured against this pin)
    │  runs(status=queued)
    ▼
 worker   claim: FOR UPDATE SKIP LOCKED, at most 3 concurrent
    │
    ├─ HOST git: fetch mirror ─▶ clone at base_sha ─▶ tar(uid 10001) ─▶ ws-<taskId>
    │
    ├─ container starts: no GitHub token, no OpenAI key, read-only rootfs
    │     model calls go out over a bind-mounted unix socket the host owns
    │
    ├─ NDJSON on stdout ─▶ events(run_id, seq) ─▶ ws://127.0.0.1:8787 ─▶ browser
    │
    ├─ after each turn that wrote: HOST extracts the volume and runs
    │     `git diff <base_sha>` ─▶ durable `diff` event
    │
    └─ Push branch / Open PR: HOST commits, pushes with the stored PAT,
          and opens the pull request. The container is already gone.
```

Follow-up turns are a new run against the same **warm** workspace — the volume
outlives its container, so the second turn skips the clone entirely and its
events continue in the same transcript.

A real run of exactly that, streamed live:

```
+0.0s  seq   769  status      running        ← host, before any container
+0.6s  seq   773  setup_log   reusing the warm workspace in ws-task_ca13…
+0.9s  seq   960  phase       agent
+3.1s  seq  1024  tool_call   grep
+7.4s  seq  1280  tool_call   apply_patch
+9.9s  seq  1473  diff        1 file: added CONTRIBUTING.md +12/-0   ← host-derived
+11.2s seq  1536  message     "I added a short 'Reporting issues' section…"
+11.4s seq  1728  status      succeeded
```

...ending in <https://github.com/retr0Tech/repoTest/pull/1>.

## What works today

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
- **The derived diff** — after each turn that changed something, the host
  extracts the workspace and runs `git diff` against the pinned SHA. Untracked
  files are staged first, in a throwaway copy, so a brand-new file shows up as
  an addition instead of as nothing at all. The Diff tab renders that patch.
- **Follow-up turns** — a new run against the same warm workspace, continuing
  the same task and the same transcript. One run per task at a time, so a
  follow-up queues behind whatever is already in flight.
- **Push branch and open PR** — the host commits the workspace, pushes with the
  stored PAT, and opens the pull request. Opening one twice returns the existing
  PR rather than failing. The resulting URLs appear in the task header.
- **Cancel** — closes the gateway meter first, so no further model call is
  admitted even mid-turn, then SIGTERMs with a grace period. Partial work
  survives, because the workspace volume is the live state.
- **`/mock/transcript`** — replays a recorded run through the same reducer the
  socket feeds, including cancellation, budget exhaustion, and a failed setup
  script. Useful for seeing states a happy run does not produce.

**Not built:** archive and restore via cold snapshots (milestone 8), scheduled
jobs (milestone 9), and the cost/budget UI (milestone 10). The `/scheduled` page
still renders fixtures, and the idle reaper that would move a workspace to the
cold tier does not exist — a task's volume lives until you remove it.

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

**The diff is derived, not reported.** The agent is asked what to change; it is
never asked what changed. After every turn the host extracts the workspace
volume and runs `git diff` against the pinned SHA, so the diff view shows what
actually happened and an agent that hallucinates a successful edit is
contradicted by its own transcript. Ask mode is enforced the same way — the tool
list omits `apply_patch` and the workspace mounts read-only, so a jailbroken
agent still cannot write.

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
