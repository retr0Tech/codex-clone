import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import Docker from "dockerode";
import { createDb } from "@codex-clone/db";
import { redact } from "@codex-clone/core";
import { MirrorManager } from "@codex-clone/github";
import { DockerSandbox } from "@codex-clone/sandbox-docker";
import { config } from "./config.js";
import { EncryptedCredentialStore } from "./credentials.js";
import { OpenAiUpstream } from "./gateway/openai-upstream.js";
import { GatewayServer } from "./gateway/server.js";
import { RunQueue } from "./runner/queue.js";
import { recordUsage } from "./runner/run-state.js";
import type { SupervisorDeps } from "./runner/supervisor.js";

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

  // Milestone 4: the model gateway. It holds the OpenAI key so the sandbox
  // never does, and it is the single place run budgets are enforced.
  const gateway = new GatewayServer({
    socketPath: config.gatewaySocketPath,
    credentials,
    upstream: new OpenAiUpstream(),
    budget: config.budget,
    onError: (message) => console.error(`[gateway] ${redact(message)}`),
    // Token deltas are the one thing broadcast but never persisted; the WS hub
    // subscribes to them in milestone 6.
    onUsage: (runId, _usage, snapshot) => {
      void recordUsage(db, runId, snapshot).catch((err: unknown) => {
        console.warn(`[worker] could not record usage for ${runId.slice(0, 8)}: ${redact(String(err))}`);
      });
    },
  });
  await gateway.listen();
  console.log(`[worker] model gateway listening on ${config.gatewaySocketPath}`);

  const deps: SupervisorDeps = {
    db,
    docker: new Docker({ socketPath: config.dockerSocket }),
    sandboxes,
    mirrors: new MirrorManager({ dataDir: config.dataDir }),
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
    log: (message) => console.log(redact(message)),
  };

  const queue = new RunQueue({
    deps,
    workerId: `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`,
    maxConcurrent: config.maxConcurrentSandboxes,
  });

  // Reconcile against Docker rather than trusting in-memory state: a worker
  // restart must not orphan running containers (PLAN.md §7, risk 5).
  await queue.reconcile();
  queue.start();
  console.log(`[worker] run queue consuming, up to ${config.maxConcurrentSandboxes} concurrent sandbox(es)`);

  // Milestone 6: WebSocket hub on config.wsPort, backfill-then-live by seq.
  // Milestone 8: idle reaper -- export cold snapshot, drop hot volume.
  // Milestone 9: scheduler tick every config.schedulerTickMs.

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} received, shutting down`);
    await queue.stop();
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
