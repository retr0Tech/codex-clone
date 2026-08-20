# Codex Clone — Build Plan

Web-based AI agent coding app: isolated container workspaces, GitHub-backed, scheduled jobs.
Target repo: `github.com/retr0Tech/codex-clone`.

---

## 0. Blockers to clear before commit 0

| Blocker | Detail | Fix |
|---|---|---|
| Docker socket | `/var/run/docker.sock → /Users/retr0Tech/.docker/run/docker.sock`; Docker Desktop is not running under `elliot.melo.do` | Launch Docker Desktop in this account, or do the work from the `retr0Tech` macOS account |
| GitHub identity | `gh` is authed as `Elliot-melodo_cpx`; `retr0Tech/codex-clone` does not resolve | Create the repo and auth as its owner; invite `bauerjon` |
| Node version | 18.18 installed | Move to Node 22 |

---

## 1. Shape

Four processes plus ephemeral sandboxes:

```
  browser
    │  HTTP (pages, REST)        ws://localhost:8787 (events)
    ▼                                     │
  web  ── Next.js 15, stock App Router ───┼──────────┐
    │                                     │          │
    ▼                                     ▼          ▼
  postgres  ◄──────────────────────────  worker ── model-gateway
                                           │         (holds OpenAI key)
                                           │ dockerode
                                           ▼
                                     agent container
                                     (zero credentials)
```

- **web** — Next.js 15, TypeScript, Tailwind, shadcn/ui. Pages + REST only; no WebSocket upgrade, so it stays a stock App Router app with no custom server.
- **worker** — owns container lifecycle, the event log, the WS hub, the scheduler tick, and the model gateway. It sees every event first, so hosting the hub here means zero fanout hops.
- **postgres** — in `docker-compose`. Docker is already mandatory for sandboxes, so this adds no new dependency class.
- **agent container** — one per task, ephemeral, holds no secrets at all.

Stack: Drizzle ORM, dockerode, Node 22. Single local user, no auth; everything binds to `127.0.0.1`.

---

## 2. The two interfaces that carry the cloud story

```ts
interface SandboxProvider {           // DockerSandbox now → Fargate/Firecracker later
  create(spec: SandboxSpec): Promise<Handle>
  attach(h: Handle): AsyncIterable<AgentEvent>
  destroy(h: Handle): Promise<void>
}

interface SnapshotStore {             // local FS now → S3 later
  put(taskId: string, src: Readable): Promise<void>
  get(taskId: string): Promise<Readable>
}
```

The agent loop runs **inside** the container and streams NDJSON on stdout. The orchestrator only does create / attach / destroy. That boundary is what makes the cloud migration a config change rather than a rewrite, and it is the first thing the architecture conversation will probe.

---

## 3. Locked decisions

### 3.1 Container lifetime — warm with idle TTL, state durable every turn

```
turn 1 → create → run → keep warm
turn 2 → reuse (fast) → run
   …15 min idle…
reaper → export cold snapshot → destroy volume
turn 3 → restore from cold → run
```

Follow-ups are fast, and because workspace state lives in a named volume, "durable after every turn" is free rather than a per-turn export.

> **Risk accepted:** cold restore now only executes on wake-after-reap. That is a rarely-run path, which is how it rots. Ship an integration test that reaps and wakes.

### 3.2 Snapshots — two-tier

```
HOT   docker volume ws-<taskId>       live /workspace, free, per-turn
        │ idle reap
        ▼
COLD  SnapshotStore <taskId>.tar.zst  repo + .git + uncommitted edits
                                      EXCLUDES node_modules / .venv / caches
        │ wake
        ▼
      restore → re-run setup script
```

Maps directly onto EBS-or-EFS hot / S3 cold in production.

### 3.3 Secret custody — the container holds nothing

- **GitHub**: the host clones into the volume and pushes from the host. No GitHub credential ever enters the container. The agent cannot read issues or fetch new remote branches; when a task references an issue, the host fetches it and injects the text into the prompt.
- **OpenAI**: the agent loop POSTs to a **host model-gateway over a bind-mounted unix socket**. The host attaches the key and forwards to `api.openai.com`, streaming back.

```
container: POST unix:/run/gateway.sock /responses   ← no key, no env var
     ▼
host gateway: attach key → api.openai.com
              stream back, record tokens + cost per run
```

So: **the sandbox holds zero credentials.** Package-registry egress stays open, but there is nothing in the container worth exfiltrating. The gateway also gives one central place for cost accounting, and a fake gateway makes agent-loop tests run with no network.

Credentials at rest: AES-256-GCM, key from `APP_ENCRYPTION_KEY`, masked in UI, redacting logger applied globally.

### 3.4 Run bounds — budgets at the gateway, graceful wind-down

```
budgets: maxTurns 40 │ maxCostUSD 5 │ wallClock 20m

breach → inject "wrap up and summarize" → 1 final turn
       → SIGTERM → 10s grace → SIGKILL
```

Cancel from the UI takes the same path. Partial work survives automatically because the volume is the live state; the run is marked `cancelled` with the transcript intact and a visible reason.

### 3.5 Scheduler — durable, claim-based

```
jobs(cron, next_run_at, on_overlap, catchup)

tick 30s:
  SELECT … WHERE next_run_at <= now() FOR UPDATE SKIP LOCKED
  → claim → fresh workspace → run → next_run_at = cronNext()

overlap:  skip, and record a 'skipped' execution so it is visible
downtime: fire once on recovery, not N times
result:   push scheduled/<job>/<timestamp>, optionally open a PR
```

Survives restarts, cannot double-fire across workers. An unattended diff that dies with its container is worthless, hence the auto-push.

### 3.6 Events and streaming

Transport is WebSocket (bidirectional, so cancel rides the same channel). The drift risk is neutralised by making the shapes identical:

```
worker: docker attach → events table → ws hub
browser: ws://localhost:8787?taskId&after=<seq>
         hub backfills seq > after, then goes live

frame === row === { seq, type, payload }
  → ONE reducer serves live and history
  → reconnect resumes exactly
```

Durable event types: `setup_log`, `reasoning`, `tool_call`, `tool_result`, `diff`, `status`. Token deltas ride the same socket but are **never persisted** — the client treats durable events as truth and overlays deltas optimistically.

### 3.7 Workspace warm-up

```
host: ~/.codexclone/mirrors/<repo>.git   (bare, refreshed on demand)
        clone --reference → volume       (seconds, no API call per task)

container start:
  phase=setup   run repo.setupScript      (npm ci / uv sync — configured in Settings)
                mounts /cache/npm (shared, warm)
                stdout streamed as setup events
  phase=agent   loop begins
```

A failing install is visible in the transcript as its own phase, not a mystery.

> **Risk accepted:** the shared package cache is a cross-workspace channel — a malicious agent can poison it for the next task. Production fix is a per-tenant cache namespace. Document it.

### 3.8 Agent tools, and truth about diffs

```
tools: shell │ apply_patch │ read_file │ grep
```

After every turn the **host** runs `git diff <baseSha>` inside the volume and emits that as the durable `diff` event. The diff view therefore shows reality, never the agent's account of reality.

**Ask mode is structural, not prompted**: the tool list omits `apply_patch` and the workspace mounts read-only. A jailbroken agent still cannot write.

### 3.9 Concurrency

Worker runs at most **3** concurrent containers (laptop-calibrated, configurable). Tasks queue in Postgres using the same `FOR UPDATE SKIP LOCKED` claim as the scheduler. Queued tasks show as `queued` in the UI rather than appearing hung.

### 3.10 Archive / restore

Archive is a status change, not a deletion: the event log is retained in full and the cold snapshot is kept. Restore recreates a container from the cold snapshot **as it was** — no automatic rebase onto a moved base branch. Offer an explicit "rebase onto latest `main`" button so the user chooses.

---

## 4. Milestones

Commit 0 lands **all shared interfaces, event-type unions, and the full initial schema** before any parallel work starts. Agents in a wave then only add files under their own directory and never touch shared types. Within a wave, exactly one milestone owns schema changes; the others rebase after it merges.

```
commit 0: contracts + full schema + CI        (solo)
   │
   ├── wave A: settings + github              (schema owner)
   ├── wave B: sandbox + agent runtime        (no schema)
   └── wave C: UI shell vs. mock events       (no schema)
   │
   integrate → milestone 5 vertical slice → sequential from there
```

| # | Milestone | Wave | Tier |
|---|---|---|---|
| 0 | Scaffold, interfaces, schema, compose, CI | solo | — |
| 1 | Encrypted credential store + Settings page | A | T2 |
| 2 | GitHub client — repos, branches, mirrors | A | T1 |
| 3 | `DockerSandbox` + agent base image | B | T1 |
| 4 | In-container agent loop + model gateway | B | T1 |
| 5 | Task create → worker → clone → run, end to end | — | T1 |
| 6 | WS hub + live transcript UI | C→ | T1 |
| 7 | Follow-up turns, diff view, push branch / open PR | — | T1 |
| 8 | Archive + restore via cold snapshots | — | T2 |
| 9 | Scheduled jobs | — | T2 |
| 10 | Cancel, budgets, timeouts, cost tracking | — | T3 |
| 11 | Conductor setup/run scripts (per-workspace DB + port) | — | T3 |
| 12 | README, ARCHITECTURE.md, DEPLOYMENT.md, known gaps | — | T2 |

Each milestone is a branch → PR → squash-merge, so the build reads as a sequence of intentional steps.

---

## 5. Cut order

| Tier | Contents | Rule |
|---|---|---|
| **T1 — must work flawlessly** | pick repo → prompt → isolated container → streaming transcript → real diff → push branch/PR → follow-up turn | never cut |
| **T2 — explicitly required** | Settings with encrypted creds, scheduled jobs, archive/restore, docs | cut only after T3 is gone |
| **T3 — shows up in conversation** | cost UI, Conductor scripts, egress hardening | cut first |

Anything cut from T3 becomes a written `DEPLOYMENT.md` section. The brief explicitly rewards documenting what remains and how you would finish it.

---

## 6. For the deployment conversation

Points to have ready, most of which fall out of decisions above:

- **Isolation in production** — Firecracker/gVisor over shared-kernel containers; one sandbox per task, no reuse across tenants.
- **Secrets** — the local design already keeps the sandbox credential-free. In production the PAT becomes a **GitHub App issuing short-lived per-task installation tokens**, and the model gateway becomes a metering broker.
- **Egress** — allowlist proxy in front of every sandbox; per-tenant package cache namespaces (closes 3.7).
- **Scale** — worker pool consuming the same `SKIP LOCKED` queue; `SandboxProvider` swapped for Fargate or a Firecracker pool; hot volume → EBS/EFS, cold → S3.
- **Cost** — dominated by sandbox-minutes and tokens, not by the control plane.
- **Before production** — auth and multi-tenancy, per-tenant quotas, audit log on credential access, sandbox image supply-chain pinning.

---

## 7. Open risks

1. Cold-restore path is rarely exercised → needs a reap/wake integration test.
2. Shared package cache is a cross-workspace channel.
3. Large-repo clone time even with a local mirror; consider partial clone (`--filter=blob:none`).
4. Model gateway is a single point of failure for every running task — needs a clear failure event, not a hang.
5. `docker attach` stream loss on worker restart — reconcile container state against the DB on boot.
