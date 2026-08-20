import { mkdir } from "node:fs/promises";
import { createDb } from "@codex-clone/db";
import { config } from "./config.js";

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

  // Milestone 4: model gateway on config.gatewaySocketPath (holds the OpenAI key).
  // Milestone 3: DockerSandbox provider + boot reconciliation against runs.sandbox_id.
  // Milestone 5: run queue consumer -- FOR UPDATE SKIP LOCKED, max N concurrent.
  // Milestone 6: WebSocket hub on config.wsPort, backfill-then-live by seq.
  // Milestone 8: idle reaper -- export cold snapshot, drop hot volume.
  // Milestone 9: scheduler tick every config.schedulerTickMs.

  console.log(`[worker] ready (subsystems land per PLAN.md milestones)`);

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, shutting down`);
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
