import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import Docker from "dockerode";
import { createDb } from "@codex-clone/db";
import { redact } from "@codex-clone/core";
import { GitHubClient, MirrorManager, createOctokit } from "@codex-clone/github";
import { DockerSandbox } from "@codex-clone/sandbox-docker";
import { config } from "./config.js";
import { EncryptedCredentialStore } from "./credentials.js";
import { OpenAiUpstream } from "./gateway/openai-upstream.js";
import { GatewayServer } from "./gateway/server.js";
import { EventHub } from "./hub/server.js";
import { archiveRoutes, IdleReaper } from "./reaper/index.js";
import { PublishError, publishTask } from "./runner/publish.js";
import { RunQueue } from "./runner/queue.js";
import { recordUsage } from "./runner/run-state.js";
import type { SupervisorDeps } from "./runner/supervisor.js";
import { RunNowError, Scheduler } from "./scheduler/index.js";
import { FsSnapshotStore } from "./snapshots/index.js";

/**
 * Worker entrypoint.
 *
 * The worker owns everything with a lifecycle: sandbox containers, the event
 * log, the WebSocket hub, the scheduler tick, and the model gateway. The web
 * app is a stock Next.js App Router process with no custom server and no
 * WebSocket upgrade of its own.
 *
 * Startup order is a constraint, not a preference: the gateway socket must be
 * listening before any container is created, because Docker resolves the bind
 * mount at container-start time and a missing socket leaves the container in
 * `created` -- a silent hang rather than an error.
 */
async function main(): Promise<void> {
  await Promise.all([
    mkdir(config.mirrorsDir, { recursive: true }),
    mkdir(config.snapshotsDir, { recursive: true }),
  ]);

  const { db, close } = createDb(config.databaseUrl);
  await db.execute("select 1");
  console.log(`[worker] db connected`);
  console.log(`[worker] docker socket ${config.dockerSocket}`);

  // Milestone 3: the sandbox provider. Every log line about a container goes
  // through redact() -- the container prints whatever the agent tells it to.
  const sandboxes = new DockerSandbox({
    socketPath: config.dockerSocket,
    // Job specs are written host-side and bind-mounted read-only into the
    // container, so the prompt never travels as env.
    jobSpecDir: join(config.dataDir, "jobs"),
    defaultMaxTurns: config.budget.maxTurns,
    onStderr: (line, handle) => console.warn(`[sandbox ${handle.id.slice(0, 8)}] ${redact(line)}`),
  });

  // The credential store: AES-256-GCM in Postgres, fed from the Settings page.
  // APP_ENCRYPTION_KEY is the only secret in this process's environment.
  const credentials = EncryptedCredentialStore.fromDatabase(db);

  // Milestone 6: the live transcript hub. Constructed before the gateway so
  // the gateway's delta callback can hand tokens straight to it.
  //
  // `cancel` is filled in once the queue exists: the socket is bidirectional
  // precisely so cancel can ride it, but the thing that does the stopping is
  // the queue, which owns the run's controller and its container handle.
  let cancelRun: (runId: string) => Promise<boolean> = () => Promise.resolve(false);
  // Same forward reference, for the same reason: "run now" has to reach the
  // scheduler, and the scheduler is built after the hub that routes to it.
  let runJobNow: (jobId: string) => Promise<{ taskId: string; workBranch: string }> = () =>
    Promise.reject(new Error("the scheduler is not running yet"));
  const docker = new Docker({ socketPath: config.dockerSocket });
  // Milestone 8: the cold tier. Local filesystem today; the SnapshotStore
  // interface is stream-in / stream-out so S3 drops straight in.
  const mirrors = new MirrorManager({ dataDir: config.dataDir });
  const snapshotStore = new FsSnapshotStore(config.snapshotsDir);
  const reaperDeps = {
    db,
    docker,
    store: snapshotStore,
    mirrors,
    githubToken: () => credentials.getGithubToken(),
    config: {
      image: config.agentImage,
      dataDir: config.dataDir,
      idleReapMs: config.idleReapMs,
      pollMs: config.reaperPollMs,
    },
    isRunning: (taskId: string) => queue.isRunning(taskId),
    log: (message: string) => console.log(redact(message)),
  };
  const publishDeps = {
    db,
    docker,
    githubToken: () => credentials.getGithubToken(),
    config: { image: config.agentImage, dataDir: config.dataDir },
    log: (message: string) => console.log(redact(message)),
  };

  const hub = new EventHub({
    db,
    port: config.wsPort,
    host: config.bindHost,
    onCancel: (runId) => cancelRun(runId),
    log: (message) => console.log(redact(message)),
    routes: {
      // Committing and pushing needs the workspace VOLUME, which only this
      // process can reach -- and the PAT, which never leaves it. The web app
      // proxies here server-side.
      "POST /control/publish": async (body) => {
        const input = body as { taskId?: unknown; openPullRequest?: unknown; title?: unknown; body?: unknown };
        if (typeof input.taskId !== "string" || input.taskId === "") {
          return { status: 400, body: { error: "taskId is required" } };
        }
        // Publishing rewrites .git inside the volume; doing that under a live
        // agent would race the thing that is writing the working tree.
        if (queue.isRunning(input.taskId)) {
          return { status: 409, body: { error: "this task has a run in flight; wait for it to finish" } };
        }
        try {
          const result = await publishTask(publishDeps, input.taskId, {
            openPullRequest: input.openPullRequest === true,
            ...(typeof input.title === "string" ? { title: input.title } : {}),
            ...(typeof input.body === "string" ? { body: input.body } : {}),
          });
          return { status: 200, body: result };
        } catch (error) {
          const message = redact(error instanceof Error ? error.message : String(error));
          console.warn(`[worker] publish failed: ${message}`);
          return { status: error instanceof PublishError ? 400 : 500, body: { error: message } };
        }
      },
      // Milestone 8: archive, restore, and the explicit rebase. Same reasoning
      // as publish -- each one needs the workspace volume.
      ...archiveRoutes(reaperDeps),
      // Milestone 9: "Run now". It lives here rather than in the web app so
      // that a manual run takes the identical fire path a scheduled one does --
      // fresh task, fresh workspace, same execution row.
      "POST /control/schedule/run": async (body) => {
        const input = body as { jobId?: unknown };
        if (typeof input.jobId !== "string" || input.jobId === "") {
          return { status: 400, body: { error: "jobId is required" } };
        }
        try {
          return { status: 202, body: await runJobNow(input.jobId) };
        } catch (error) {
          const message = redact(error instanceof Error ? error.message : String(error));
          console.warn(`[worker] run-now failed: ${message}`);
          return { status: error instanceof RunNowError ? 409 : 500, body: { error: message } };
        }
      },
    },
  });

  // Milestone 4: the model gateway. It holds the OpenAI key so the sandbox
  // never does, and it is the single place run budgets are enforced.
  const gateway = new GatewayServer({
    socketPath: config.gatewaySocketPath,
    credentials,
    upstream: new OpenAiUpstream(),
    budget: config.budget,
    onError: (message) => console.error(`[gateway] ${redact(message)}`),
    // The one thing broadcast but never persisted. The durable `message` the
    // agent emits at end of turn supersedes it (PLAN.md §3.6).
    onDelta: (runId, messageId, text) => hub.publishDelta(runId, messageId, text),
    onUsage: (runId, _usage, snapshot) => {
      void recordUsage(db, runId, snapshot).catch((err: unknown) => {
        console.warn(`[worker] could not record usage for ${runId.slice(0, 8)}: ${redact(String(err))}`);
      });
    },
  });
  await gateway.listen();
  console.log(`[worker] model gateway listening on ${config.gatewaySocketPath}`);

  await hub.listen();
  console.log(`[worker] transcript hub listening on ws://${config.bindHost}:${hub.port}`);

  const deps: SupervisorDeps = {
    db,
    docker,
    sandboxes,
    mirrors,
    // The wake half of the two-tier store: a task the reaper has been through
    // comes back from here instead of being re-cloned at its base commit.
    snapshots: snapshotStore,
    meters: gateway.meters,
    githubToken: () => credentials.getGithubToken(),
    model: () => credentials.defaultModel(),
    config: {
      image: config.agentImage,
      gatewaySocketPath: config.gatewaySocketPath,
      limits: config.limits,
      stopGraceMs: config.stopGraceMs,
      dataDir: config.dataDir,
      cacheVolumeName: config.cacheVolumeName,
    },
    publish: (row) => hub.publish(row),
    bindRun: (runId, taskId) => hub.bindRun(runId, taskId),
    releaseRun: (runId) => hub.releaseRun(runId),
    log: (message) => console.log(redact(message)),
  };

  const queue = new RunQueue({
    deps,
    workerId: `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`,
    maxConcurrent: config.maxConcurrentSandboxes,
  });
  cancelRun = (runId) => queue.cancel(runId);

  // Reconcile against Docker rather than trusting in-memory state: a worker
  // restart must not orphan running containers (PLAN.md §7, risk 5).
  await queue.reconcile();
  queue.start();
  console.log(`[worker] run queue consuming, up to ${config.maxConcurrentSandboxes} concurrent sandbox(es)`);

  // Milestone 8: idle reaper -- export cold snapshot, drop hot volume.
  const reaper = new IdleReaper(reaperDeps);
  reaper.start();
  console.log(`[worker] idle reaper sweeping every ${config.reaperPollMs}ms, TTL ${config.idleReapMs}ms`);

  // Milestone 9: the scheduler tick. It writes ordinary queued runs, so the
  // queue above executes them through the same supervisor as everything else,
  // and it settles finished occurrences through the same publish path.
  const scheduler = new Scheduler({
    deps: {
      db,
      resolveBaseSha: async (repo, branch) => {
        const token = await credentials.getGithubToken();
        if (!token) throw new Error("no GitHub token is configured; add one on the Settings page");
        return new GitHubClient(createOctokit(token)).resolveRefSha(repo.owner, repo.name, branch);
      },
      publish: (taskId, options) => publishTask(publishDeps, taskId, options),
      log: (message) => console.log(redact(message)),
    },
    tickMs: config.schedulerTickMs,
  });
  runJobNow = async (jobId) => {
    const fired = await scheduler.runNow(jobId);
    return { taskId: fired.taskId, workBranch: fired.workBranch };
  };
  scheduler.start();
  console.log(`[worker] scheduler ticking every ${Math.round(config.schedulerTickMs / 1000)}s`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} received, shutting down`);
    await scheduler.stop();
    await queue.stop();
    // Waits for a sweep in flight: a shutdown between the snapshot and the
    // volume removal would leave a workspace half-reaped.
    await reaper.stop();
    await hub.close();
    await gateway.close();
    await close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
