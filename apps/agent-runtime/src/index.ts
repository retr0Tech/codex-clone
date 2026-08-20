import type { RunStatus } from "@codex-clone/core";
import { DurableEventWriter, log } from "./events.js";
import { UnixSocketGatewayClient } from "./gateway-client.js";
import { loadJobSpec } from "./job-spec.js";
import { runAgentLoop } from "./loop.js";
import { runSetupPhase } from "./setup.js";

/**
 * The program that runs INSIDE the sandbox container. It is the image's
 * entrypoint.
 *
 * Contract with the host:
 *   in   - a job spec, from a bind-mounted file (or stdin). Never from env.
 *   out  - NDJSON durable events on stdout, one per line, matching the frozen
 *          event union. Diagnostics on stderr.
 *   auth - none. Model calls go to a unix socket the host owns.
 *
 * It must always terminate. Every failure path below ends in a terminal
 * `status` event and an exit, because a sandbox that hangs holds a slot in a
 * pool of three and looks identical to one that is working.
 */
async function main(): Promise<number> {
  const jobSpecPath = process.env["AGENT_JOB_SPEC_PATH"] ?? "/run/job.json";
  const job = await loadJobSpec({ path: jobSpecPath, stdin: process.stdin });

  const writer = new DurableEventWriter(process.stdout, { runId: job.runId, taskId: job.taskId }, job.seqStart);

  // The host SIGTERMs on cancel and on budget wind-down (PLAN.md section 3.4).
  // We record why we stopped and exit; partial work survives regardless,
  // because the workspace volume is the live state.
  const controller = new AbortController();
  let signalled: string | null = null;
  const onSignal = (signal: string) => {
    if (signalled) return;
    signalled = signal;
    log(`${signal} received, winding down`);
    controller.abort();
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  const finish = (status: RunStatus, reason?: string): number => {
    writer.emit("phase", { phase: "done" });
    writer.emit("status", reason === undefined ? { status } : { status, reason });
    return status === "succeeded" ? 0 : 1;
  };

  const setup = await runSetupPhase(job, writer);
  if (!setup.ok) {
    writer.emit("error", {
      code: "setup_failed",
      message: setup.reason ?? "setup script failed",
      retryable: false,
    });
    return finish("failed", setup.reason ?? "setup script failed");
  }
  if (signalled) return finish("cancelled", `${signalled} during setup`);

  writer.emit("phase", { phase: "agent" });
  const gateway = new UnixSocketGatewayClient({ socketPath: job.gatewaySocketPath });

  const result = await runAgentLoop({ job, gateway, writer, signal: controller.signal });

  writer.emit("phase", { phase: "finalizing" });
  return finish(
    signalled && result.status === "succeeded" ? "cancelled" : result.status,
    signalled ? `${signalled} received` : result.reason,
  );
}

main()
  .then((code) => {
    // Let the stdout pipe drain before exiting, or the last events are lost.
    process.stdout.write("", () => process.exit(code));
  })
  .catch((err: unknown) => {
    log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(2);
  });
