import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createDb } from "@codex-clone/db";
import { redact } from "@codex-clone/core";
import { DockerSandbox } from "@codex-clone/sandbox-docker";
import { config } from "./config.js";
import { EnvCredentialStore } from "./gateway/credentials.js";
import { OpenAiUpstream } from "./gateway/openai-upstream.js";
import { GatewayServer } from "./gateway/server.js";

/**
 * Worker entrypoint.
 *
 * The worker owns everything with a lifecycle: sandbox containers, the event
 * log, the WebSocket hub, the scheduler tick, and the model gateway. The web
 * app is a stock Next.js App Router process with no custom server and no
 * WebSocket upgrade of its own.
 *
 * Commit 0 boots, connects, and reserves the seams. Each subsystem lands in
 * its own milestone -- see PLAN.md section 4.
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

  // Milestone 4: the model gateway. It holds the OpenAI key so the sandbox
  // never does, and it is the single place run budgets are enforced.
  //
  // TEMPORARY: EnvCredentialStore reads OPENAI_API_KEY from this process's
  // environment. Milestone 1 (wave A) replaces it with the AES-256-GCM store
  // in Postgres, fed from the Settings page -- one line, here.
  const gateway = new GatewayServer({
    socketPath: config.gatewaySocketPath,
    credentials: new EnvCredentialStore(),
    upstream: new OpenAiUpstream(),
    budget: config.budget,
    onError: (message) => console.error(`[gateway] ${redact(message)}`),
    // onDelta is the ephemeral token overlay; the WS hub subscribes in
    // milestone 6. Deltas are never persisted.
  });
  await gateway.listen();
  console.log(`[worker] model gateway listening on ${config.gatewaySocketPath}`);

  // Reconcile against Docker rather than trusting in-memory state: a worker
  // restart must not orphan running containers (PLAN.md section 7, risk 5).
  const alive = await sandboxes.list().catch((err: unknown) => {
    console.warn(`[worker] could not reach Docker for reconciliation: ${String(err)}`);
    return [];
  });
  console.log(`[worker] ${alive.length} sandbox(es) still running from a previous boot`);

  // Milestone 5: run queue consumer -- FOR UPDATE SKIP LOCKED, max N concurrent.
  // Milestone 6: WebSocket hub on config.wsPort, backfill-then-live by seq.
  // Milestone 8: idle reaper -- export cold snapshot, drop hot volume.
  // Milestone 9: scheduler tick every config.schedulerTickMs.

  console.log(`[worker] ready (remaining subsystems land per PLAN.md milestones)`);

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, shutting down`);
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
