# codex-clone

A web-based AI agent coding app: isolated container workspaces backed by GitHub
repositories, with scheduled jobs and a settings-managed credential store.
Local-first, built so agent execution can move to cloud infrastructure without
rewriting the orchestrator.

> **Status.** The vertical slice is complete. Pick one of your repositories and
> a branch, describe a change, and watch reasoning, tool calls and a real diff
> stream in live — then push the branch and open a pull request, all from the
> host. The same run loop is also on a schedule: a cron expression with a
> timezone gets a fresh container on a cadence and pushes what it produced.
> Every run is metered and bounded, and both the spend and the bounds are
> visible. See [The end-to-end flow](#the-end-to-end-flow) to follow it
> yourself, [What works today](#what-works-today) for what is built, and
> [Known gaps](#known-gaps) for what is deliberately not.

## Requirements

| | |
|---|---|
| macOS | the only supported host |
| Node 22+ | `nvm install 22` |
| pnpm 9 | `corepack enable` |
| Docker Desktop | must be running **under the account you develop from** |

## Quick start

Make sure **Docker Desktop is running** first — Postgres and every agent
workspace are containers.

**1. Install and configure**

```bash
corepack enable
pnpm install

cp .env.example .env.local
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# paste the output into APP_ENCRYPTION_KEY in .env.local
```

`APP_ENCRYPTION_KEY` is the only value you must fill in; everything else in
`.env.example` has a working default. Both the web app and the worker read that
single root `.env.local`.

**2. Start the database and the app**

```bash
pnpm db:up          # Postgres in Docker, bound to 127.0.0.1
pnpm db:migrate     # create the schema
pnpm agent:build    # build the agent image -> codex-clone/agent:dev
pnpm dev            # web on :3000, worker on :8787
```

**3. Add your credentials — the app does nothing without this**

Open <http://localhost:3000/settings> and enter both:

| Credential | Needed for | Scope |
|---|---|---|
| **GitHub personal access token** | listing your repositories, cloning them, pushing branches, opening pull requests | `repo` |
| **OpenAI API key** | every agent run | — |

Use **Test connection** on each; it calls the real provider, so a green result
means the credential genuinely works.

They are **not** environment variables. They are encrypted with AES-256-GCM
before they reach Postgres, shown afterwards only as a masked hint, and never
sent back to the browser. Nothing sensitive is written to the repository or to
your shell history.

Without them the app still loads, but the repository picker stays empty and any
task you create fails at its first model call with
`no OpenAI API key is configured; add one in Settings`. That is the intended
behaviour, not a crash — but it is the first thing to check if a run fails
immediately.

> Keep `.env.local` once you have entered credentials. `APP_ENCRYPTION_KEY` is
> what they are encrypted against, so regenerating it makes the stored values
> undecryptable and you will have to enter them again.

You are now ready to create a task.

### Verify your setup

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

Expect **486 tests, 0 failures**, in roughly 40 seconds, with Docker and
Postgres up and the agent image built — the integration suites skip otherwise,
with a reason, and the count is correspondingly lower. Two tests skip unless
`ripgrep` is installed on the host (`brew install ripgrep`); it is baked into
the agent image, so this affects only host-side runs.
**No test ever reaches a model provider** — every one of them runs against
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

A workspace nobody has touched for fifteen minutes moves to the cold tier, and
comes back on the next turn:

```
 HOT   docker volume ws-<taskId>        live /workspace, free, per-turn
         │  idle reap  (or Archive)
         ▼
 COLD  ~/.codexclone/snapshots/<taskId>.tar.zst
         repo + .git + uncommitted edits, sha256-verified
         WITHOUT node_modules / .venv / dist / caches
         │  wake: next turn, or Restore
         ▼
       fresh volume + the repo setup script re-runs
```

The excludes are what keep it megabytes rather than gigabytes — except for a
directory the repository actually tracks, which is never dropped, so a repo that
commits its `dist/` still restores byte-for-byte. Nothing else does: `git diff`
against the restored workspace is empty, the uncommitted edit the agent left is
still there, and the file modes survive.

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
  survives, because the workspace volume is the live state. The agent gets one
  final turn to commit what it has, so the button reads **Cancelling…** for a
  few seconds rather than pretending the stop was instant — and a run you
  stopped is recorded as `cancelled` with **no** budget breach, however close to
  a ceiling it happened to be.
- **Run bounds and cost visibility** (`/usage`, and a Usage tab per task) —
  every run has been metered at the gateway since milestone 4; this is where
  those figures surface. Turns, input, output, **cached input** and cost, per
  run and per task, with a bar for each bound showing how close the run came and
  which one stopped it. Budgets are editable in Settings — turns, cost and wall
  clock — and are resolved once per run, so an edit lands on the next run and
  never moves under a run already being measured against it.
- **Timeouts that actually fire** — the gateway checks the wall clock when a
  model call arrives, which cannot help an agent wedged inside a tool call that
  never returns. The host arms its own deadline for the same bound: meter
  closed, then SIGTERM with the grace period, and the run is recorded
  `timed_out` rather than sitting on a concurrency slot forever. `timed_out`
  means the wall clock; `budget_exhausted` means turns or cost. They are
  different signals and read differently.
- **Archive and restore, via cold snapshots** — a workspace idle for
  `IDLE_REAP_MS` (15 minutes) is exported to `~/.codexclone/snapshots/<taskId>.tar.zst`
  and its Docker volume is freed; the next turn restores it and carries on.
  Archiving does the same thing on demand and flips the status — it is a status
  change, never a deletion, so the transcript is retained in full and the
  snapshot is kept. `/archived` lists what is cold and how much disk it holds,
  and Restore brings a task back to the sidebar. Restoring recreates the
  workspace **as it was**: uncommitted edits included, on the commit it was
  pinned to. It does not rebase — **Rebase onto `main`** is a separate button
  that also moves `tasks.base_sha`, so the next derived diff is measured
  against the new base rather than crediting the agent with someone else's
  commit.
- **Scheduled jobs** (`/scheduled`) — a repo, a branch, a prompt and a cron
  expression with a timezone. The worker claims due jobs out of Postgres with
  the same `FOR UPDATE SKIP LOCKED` the run queue uses, so a schedule survives a
  restart and cannot double-fire across workers. See
  [Scheduled jobs](#scheduled-jobs) for what the two awkward cases do.
- **`/mock/transcript`** — replays a recorded run through the same reducer the
  socket feeds, including cancellation, budget exhaustion, a wall-clock timeout,
  and a failed setup script. Useful for seeing states a happy run does not
  produce.

Everything the brief asks for is built. What is deliberately *not* here is
listed under [Known gaps](#known-gaps).

## Scheduled jobs

A scheduled execution is an ordinary task with an ordinary queued run, so the
run loop, the transcript, the derived diff and the push are all the ones you
already saw. What the scheduler adds is the claim and two decisions.

```
tick, every 30s:
  settle()  finished occurrences: push the branch, close them out
  claim()   SELECT … WHERE enabled AND next_run_at <= now()
            FOR UPDATE SKIP LOCKED
              → fresh task + queued run   → the milestone 5 run loop
              → or a 'skipped' row + why
```

Settling runs *first*, and that ordering is load-bearing: `claimed` and
`running` **are** the overlap rule, so an occurrence that has finished but not
been closed out would make the next one record a skip against work that was
already done.

**Every execution gets a brand-new task**, and therefore a workspace volume that
has never existed. That is not a policy applied on top — there is simply no task
for a scheduled run to inherit a warm volume from, which is the opposite of how
a follow-up turn works.

**Overlap.** If the previous execution is still in flight when the next
occurrence comes due, `skip` records a `skipped` row saying so and `queue`
starts it anyway. A skip is never silent: a schedule that quietly did nothing
looks exactly like one that is broken, and only one of those is fine.

**Downtime.** `next_run_at` is recomputed from *now*, never stepped forward one
occurrence at a time from the stale value, so five hours of downtime on a
five-minute schedule fires **once** on recovery and is then back on cadence.
Nothing has to count what was missed. With catch-up switched off, the missed
occurrence is recorded as skipped instead — still visible, still not sixty rows.

**The result.** An unattended diff that dies with its container is worthless, so
the finished workspace is committed and pushed to
`scheduled/<job>/<timestamp>` — the *occurrence's* timestamp, so the 03:00 run
is called 03:00 even when the queue was busy until 03:20 — and optionally opened
as a pull request. That is the milestone 7 publish path unchanged, called once
the run is terminal: pushing rewrites `.git` inside the volume, so doing it
under a live agent would race the process writing the working tree.

Cron parsing lives in `packages/cron` (croner, pinned) because both the web app
and the worker need it: the web app computes the first `next_run_at` when a job
is created, the worker computes every one after that, and two implementations of
"when does this fire next" is how a schedule comes to disagree with the page
that shows it. Five fields, or `@daily` and friends; six-field expressions with
seconds are refused rather than silently mis-scheduled against a 30-second tick.

A scheduled execution can never be woken from the cold tier, and that falls out
of the design rather than being guarded against: `restoreWorkspace` is keyed on
`taskId`, and every occurrence gets a task id that has never existed, so there
is nothing for it to find. The transcript says so in its own words — a scheduled
run logs `no cold snapshot either; this workspace is new`, and the integration
test asserts exactly that line.

## Run bounds, cost, and stopping

Three bounds, one place they are enforced, and two ways a run can be stopped
that must never be confused with each other.

```
budget: maxTurns 40 │ maxCostUSD 1 │ wallClock 20m      (editable in Settings)

per model call ─▶ gateway meter ─▶ under budget?  forward
                                   just over?     inject wind-down, ONE more turn
                                   spent?         refuse

no model call at all ─▶ host deadline at wallClockMs ─▶ close meter ─▶ SIGTERM
```

**The gateway is the only place budgets live**, because it is the only component
every model call passes through. The container cannot be trusted to stop itself
and the worker only sees events, so nothing else can both count and refuse.

**Breaching is not a kill.** The wind-down instruction is injected and the agent
gets exactly one more turn to commit what it has and explain itself, because a
hard stop at the moment of breach throws away the most valuable turn of the run.
Only then is the container SIGTERMed.

**The wall clock needed a second enforcer.** The meter can only check elapsed
time when a model call arrives, so an agent parked inside a `shell` command that
never returns trips nothing — and used to hold one of three concurrency slots
indefinitely. The supervisor therefore arms its own timer for the same bound.
The polite path still wins when it can; this one exists for when it cannot.

**A cancelled run is never a budget breach.** Cancel and a wall-clock breach take
the same path — meter closed, then SIGTERM — but they are not the same event,
and the distinction is carried as *data*, not as prose: `runs.budget_breach` is
null for a cancelled run, and the refusal the agent receives says `cancelled`
rather than naming a bound. Deriving it after the fact from turn counts and
timings is exactly how a run someone stopped at 39 of 40 turns came to be
reported as one that ran out of budget.

So the terminal statuses mean distinct things, and the UI keeps them distinct:

| Status | What happened |
|---|---|
| `cancelled` | A person pressed Cancel. No breach, partial work kept. |
| `timed_out` | The wall clock ran out. |
| `budget_exhausted` | The turn or cost ceiling was reached. |

`/usage` and the per-task Usage tab render the figures the gateway wrote as each
run went — including **cached input tokens**, which bill at roughly a tenth of
the input rate and were recorded on every run from milestone 4 while being
displayed nowhere.

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
| `packages/cron` | Cron expressions with timezones, shared by the web app and the scheduler |
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

## Known gaps

Things that are deliberately absent rather than overlooked:

- **Budgets are global, not per task.** They are the default every run is
  measured against, resolved once at run start. Per-task overrides would need a
  budget column on `tasks` and a `MeterRegistry` that is handed one per run;
  the registry already accepts a per-run budget, so the remaining work is a
  column and a form field.
- **Headroom is shown against the *current* budget.** A bound raised after a run
  finished makes that run look roomier than it felt. Storing the budget on each
  run would fix it, at three more columns per run — not worth it here.
- **No auth, no multi-tenancy, no per-tenant quotas.** Everything binds to
  `127.0.0.1` and assumes a single local user.
- **The shared package cache is a cross-workspace channel** (PLAN.md §3.7): a
  hostile agent can poison it for the next task. Production fix is a per-tenant
  cache namespace.
- **Package-registry egress is open.** There is nothing in the container worth
  exfiltrating, but production wants an allowlist proxy in front of the sandbox.
- **Model prices are a hand-maintained table** in `apps/worker/src/gateway/pricing.ts`.
  An unknown model bills at the most expensive known rate rather than at zero,
  so a stale table under-reports rather than silently disabling the cost budget.

## Troubleshooting

**`no OpenAI API key is configured; add one in Settings`** — the run reached the
model gateway without a key. Add one at `/settings`; it takes effect on the next
run, with no restart, because the gateway reads it per call rather than caching
it.

**The repository picker is empty, or `/api/repos` returns 412** — no GitHub
token is stored. Add a PAT with `repo` scope at `/settings`.

**A run fails immediately after "workspace ready"** — almost always one of the
two credentials above. Open the task's transcript: the terminal `status` event
carries the reason verbatim.

**`Missing required env var: APP_ENCRYPTION_KEY`** — `.env.local` is missing or
the key is blank. It must live at the repository root, not in `apps/`.

**Credentials you already saved stopped working** — `APP_ENCRYPTION_KEY`
changed, so the stored ciphertext can no longer be decrypted. Re-enter both
credentials at `/settings`.

**`connect ENOENT .../docker.sock`** — Docker Desktop is not running, or it was
installed under a different macOS account. Docker creates a *per-user* socket;
`/var/run/docker.sock` may symlink into another user's home and be unreadable.
Point `DOCKER_SOCKET` at `$HOME/.docker/run/docker.sock`.

**Database connection refused** — run `pnpm db:up` and give Postgres a few
seconds; the container has a healthcheck.

## Working on several changes at once

The repository is wired for [Conductor](https://www.conductor.build/), which
runs each task in its own git worktree. `.conductor/settings.toml` points at
three scripts, and between them they let several workspaces run **at the same
time** without touching each other's state:

| | |
|---|---|
| `.conductor/setup.sh` | installs (the root `prepare` script builds the packages), allocates ports, creates the workspace's database, migrates it, writes its `.env.local` |
| `.conductor/run.sh` | starts web + worker on the ports setup allocated |
| `.conductor/archive.sh` | drops the database, data dir, containers, volumes and port reservations when the workspace is deleted |

Each workspace gets its own:

| Resource | Per workspace |
|---|---|
| Postgres database | `codexclone_<workspace>` in the **one shared** server on `:5432` |
| Web port | allocated, recorded in `.env.local` as `WEB_PORT` |
| Worker WebSocket port | allocated, with `NEXT_PUBLIC_WS_URL` kept in step |
| `CODEX_DATA_DIR` | `~/.codexclone/workspaces/<workspace>` — mirrors, snapshots, job specs, and the **gateway unix socket**, which two workers cannot share |
| `CODEX_WORKSPACE_ID` | labels the workspace's containers, so one worker's boot reconciliation cannot mistake another's live sandboxes for orphans and destroy them |

Ports are **allocated, not hashed**: each candidate is claimed by an atomic
`mkdir` under `~/.codexclone/conductor/ports/<port>`, so two setups racing
cannot both take 3001, and a workspace that is set up but not running still
holds its port. 3000 and 8787 are never handed out — they belong to a plain
`pnpm dev`. Re-running setup reuses what it already allocated.

Docker sandbox containers and `ws-*` volumes are named from task ids, which are
random UUIDs, so those names never collide across workspaces and are left
alone. The package-manager cache volume stays shared on purpose.

**`APP_ENCRYPTION_KEY` is reused** from the parent checkout's `.env.local` if
there is one, so a credential you saved once still decrypts. If there is
nothing to reuse, setup generates a key and says so in a box you cannot miss —
credentials encrypted under a different key are not recoverable, so that is not
a thing to discover later. Each workspace has its own database either way, so
Settings starts empty and you will enter the PAT and the API key again.

The workspace's database is created empty and then migrated with the branch's
own migrations, so it lands on the same schema version as everything else in
the checkout rather than one behind.

Nothing here is Conductor-specific: the scripts fall back to `git` when
Conductor's environment variables are absent, so a plain `git worktree add`
followed by `./.conductor/setup.sh` works the same way.

## Development

```bash
pnpm dev            # web + worker together
pnpm test           # full suite
pnpm db:generate    # after editing packages/db/src/schema.ts
pnpm db:down        # stop Postgres
```
