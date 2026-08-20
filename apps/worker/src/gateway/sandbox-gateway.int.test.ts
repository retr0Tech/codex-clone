import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import Docker from "dockerode";
import { DEFAULT_LIMITS, type AnyEventRow, type SandboxHandle, type SandboxSpec } from "@codex-clone/core";
import {
  acquireDockerTestLock,
  DockerSandbox,
  removeVolume,
  type DockerSandboxSpec,
  type DockerTestLock,
} from "@codex-clone/sandbox-docker";
import { StaticCredentialStore } from "./credentials.js";
import { FakeUpstream, upstream } from "./fake-upstream.js";
import { GatewayServer } from "./server.js";

/**
 * Milestones 3 and 4 composed: a REAL container running the REAL agent image,
 * reaching a REAL gateway over a bind-mounted unix socket -- with a fake model
 * provider, so this runs with no API key and no egress.
 *
 * This is the test that proves the central claim of the design: the sandbox
 * holds zero credentials and still completes a turn. The agent below runs a
 * shell command, writes a file, and reports back, having never seen a key.
 *
 * Skips cleanly when Docker or the image is absent.
 */

const IMAGE = process.env["AGENT_IMAGE"] ?? "codex-clone/agent:dev";
const SOCKET = process.env["DOCKER_SOCKET"] ?? join(homedir(), ".docker", "run", "docker.sock");
const FAKE_KEY = "sk-test-not-a-real-key-000000000000";

async function unavailableReason(): Promise<string | false> {
  const docker = new Docker({ socketPath: SOCKET });
  try {
    await docker.ping();
  } catch (err) {
    return `Docker is not reachable at ${SOCKET} (${(err as Error).message}); skipping end-to-end test`;
  }
  try {
    await docker.getImage(IMAGE).inspect();
  } catch {
    return `sandbox image "${IMAGE}" is not built; run \`pnpm agent:build\` to enable this test`;
  }
  return false;
}

const skip = await unavailableReason();

describe("agent container <-> host gateway", { skip: skip === false ? undefined : skip }, () => {
  let docker: Docker;
  let hostDir: string;
  let sandbox: DockerSandbox;
  const cleanup: Array<{ handle: SandboxHandle; volume: string }> = [];
  // Volumes are recorded before the container exists, so a failed create still
  // gets cleaned up rather than leaking a volume per run.
  const volumes = new Set<string>();
  const gateways = new Set<GatewayServer>();
  let lock: DockerTestLock;

  before(async () => {
    // `pnpm -r test` runs package suites concurrently, and two suites driving
    // Docker Desktop at once wedge its socket forwarder. See test-lock.ts.
    lock = await acquireDockerTestLock();
    docker = new Docker({ socketPath: SOCKET });
    // Under $HOME: Docker Desktop's default file-sharing allowlist covers
    // /Users but not /private/var/folders, and this is also where the real
    // gateway socket lives (config.dataDir).
    hostDir = await realpath(await mkdtemp(join(homedir(), ".codexclone-e2e-")));
    // Create both mount-source directories up front so only the socket files
    // themselves are new by the time a container binds them.
    await mkdir(join(hostDir, "gw"), { recursive: true, mode: 0o700 });
    await mkdir(join(hostDir, "jobs"), { recursive: true, mode: 0o700 });
    sandbox = new DockerSandbox({ socketPath: SOCKET, jobSpecDir: join(hostDir, "jobs") });
  });

  // Every step is independently guarded: a failure part-way through cleanup
  // must not leave containers, volumes, host directories or listening sockets
  // behind. A leaked server handle in particular keeps the Node process alive
  // after the last test, which looks exactly like a hang.
  after(async () => {
    for (const gateway of gateways) await gateway.close().catch(() => undefined);
    for (const { handle } of cleanup) await sandbox?.destroy(handle).catch(() => undefined);
    for (const volume of volumes) await removeVolume(docker, volume, { force: true }).catch(() => undefined);
    if (hostDir) await rm(hostDir, { recursive: true, force: true }).catch(() => undefined);
    await lock?.release().catch(() => undefined);
  });

  async function runTurn(
    turns: ConstructorParameters<typeof FakeUpstream>[0],
    over: Partial<SandboxSpec> = {},
    job: Partial<DockerSandboxSpec["job"]> = {},
  ): Promise<{ rows: AnyEventRow[]; fake: FakeUpstream; volume: string }> {
    // A long-lived directory with a unique socket name inside it, rather than a
    // fresh directory per run. Docker Desktop propagates host filesystem
    // changes into its VM asynchronously, and a brand-new directory is the
    // slowest case to become visible -- which is what made container start
    // intermittently fail to find the socket. Production has the same shape:
    // one stable dir (config.dataDir) holding a stable gateway.sock.
    const socketPath = join(hostDir, "gw", `${randomUUID().slice(0, 8)}.sock`);
    const fake = new FakeUpstream(turns);
    const gateway = new GatewayServer({
      socketPath,
      credentials: new StaticCredentialStore(FAKE_KEY),
      upstream: fake,
      budget: { maxTurns: 10, maxCostUsd: 100, wallClockMs: 120_000 },
    });

    const taskId = `e2e-${randomUUID().slice(0, 8)}`;
    const volume = `codex-e2e-${taskId}`;
    volumes.add(volume);
    gateways.add(gateway);

    // listen() does not resolve until the socket is on disk and accepting, so
    // the container below can safely bind-mount it.
    await gateway.listen();

    try {
      const spec: DockerSandboxSpec = {
        taskId,
        runId: `run-${taskId}`,
        image: IMAGE,
        mode: "code",
        volumeName: volume,
        gatewaySocketPath: socketPath,
        limits: { ...DEFAULT_LIMITS, memoryMb: 512, cpus: 1, pids: 128 },
        env: {},
        job: { prompt: "write a greeting", baseSha: "0".repeat(40), model: "gpt-5", ...job },
        ...over,
      };

      const handle = await sandbox.create(spec as SandboxSpec);
      cleanup.push({ handle, volume });

      const rows: AnyEventRow[] = [];
      for await (const row of sandbox.attach(handle)) rows.push(row);
      return { rows, fake, volume };
    } finally {
      // Must cover the create() failure path too: an open server handle keeps
      // the Node process alive long after the tests have finished.
      await gateway.close().catch(() => undefined);
      gateways.delete(gateway);
    }
  }

  it("completes a full turn: setup, tool call, message, terminal status", async () => {
    const { rows, fake } = await runTurn([
      [
        upstream.toolCall("call_1", "shell", { command: "echo hello-from-the-sandbox > greeting.txt && cat greeting.txt" }),
        upstream.done(1000, 50),
      ],
      [upstream.delta("m1", "Wrote greeting.txt."), upstream.done(500, 20)],
    ]);

    const types = rows.map((r) => r.type);
    assert.ok(types.includes("phase"), `expected phases, got: ${types.join(", ")}`);
    assert.ok(types.includes("tool_call"), `expected a tool call, got: ${types.join(", ")}`);
    assert.ok(types.includes("tool_result"));
    assert.ok(types.includes("message"));

    const phases = rows.filter((r) => r.type === "phase").map((r) => (r.payload as { phase: string }).phase);
    assert.deepEqual(phases, ["setup", "agent", "finalizing", "done"]);

    const toolResult = rows.find((r) => r.type === "tool_result");
    const payload = toolResult?.payload as { ok: boolean; output: string; tool: string };
    assert.equal(payload.tool, "shell");
    assert.equal(payload.ok, true, `the shell command failed: ${payload.output}`);
    assert.match(payload.output, /hello-from-the-sandbox/);

    const message = rows.find((r) => r.type === "message");
    assert.equal((message?.payload as { text: string }).text, "Wrote greeting.txt.");

    const status = rows.at(-1);
    assert.equal(status?.type, "status");
    assert.equal((status?.payload as { status: string }).status, "succeeded");

    // Deltas are ephemeral: the coalesced message is the only durable record.
    assert.equal(
      rows.some((r) => (r.type as string) === "delta"),
      false,
    );

    // The host attached the key; the container never saw it.
    assert.equal(fake.lastApiKey, FAKE_KEY);
    assert.equal(JSON.stringify(rows).includes(FAKE_KEY), false, "the key must not appear anywhere in the transcript");

    // seq is monotonic from 0 -- the cursor the WebSocket backfill relies on.
    assert.deepEqual(
      rows.map((r) => r.seq),
      rows.map((_, i) => i),
    );
  });

  it("winds down cleanly when the gateway refuses, instead of hanging", async () => {
    // maxTurns is 10 in runTurn, so exhaust the scripted turns instead: the
    // fake reports an upstream error, which the gateway turns into `refused`.
    const { rows } = await runTurn([[upstream.error("simulated provider outage")]]);

    const status = rows.at(-1);
    assert.equal(status?.type, "status");
    assert.equal((status?.payload as { status: string }).status, "failed");

    const error = rows.find((r) => r.type === "error");
    assert.match((error?.payload as { code: string }).code, /gateway_refused/);
    assert.match((error?.payload as { message: string }).message, /simulated provider outage/);
  });

  it("ASK MODE: the agent is given no patch tool and the workspace rejects writes", async () => {
    const { rows, fake } = await runTurn(
      [
        [upstream.toolCall("call_1", "shell", { command: "touch /workspace/should-not-exist 2>&1" }), upstream.done(10, 10)],
        [upstream.delta("m1", "The workspace is read-only."), upstream.done(10, 10)],
      ],
      { mode: "ask" },
      { setupScript: "echo this should be skipped in ask mode" },
    );

    // The tool list the model was offered contains no apply_patch at all.
    const tools = fake.requests[0]?.tools as Array<{ name: string }>;
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["grep", "read_file", "shell"],
      "apply_patch must be absent from the tool list in ask mode",
    );

    // And the mount refuses the write regardless of what the model asks for.
    const toolResult = rows.find((r) => r.type === "tool_result");
    const payload = toolResult?.payload as { ok: boolean; output: string };
    assert.equal(payload.ok, false);
    assert.match(payload.output, /Read-only file system/);

    // The setup script is skipped rather than failing noisily on EROFS.
    const setupLog = rows
      .filter((r) => r.type === "setup_log")
      .map((r) => (r.payload as { text: string }).text)
      .join("");
    assert.match(setupLog, /read-only/);

    assert.equal((rows.at(-1)?.payload as { status: string }).status, "succeeded");
  });

  it("runs the repo setup script as its own phase, streaming its output", async () => {
    const { rows } = await runTurn(
      [[upstream.delta("m1", "nothing to do"), upstream.done(10, 10)]],
      {},
      { setupScript: "echo installing-deps; echo a-warning >&2" },
    );

    const setupLogs = rows.filter((r) => r.type === "setup_log");
    const stdout = setupLogs
      .filter((r) => (r.payload as { stream: string }).stream === "stdout")
      .map((r) => (r.payload as { text: string }).text)
      .join("");
    const stderr = setupLogs
      .filter((r) => (r.payload as { stream: string }).stream === "stderr")
      .map((r) => (r.payload as { text: string }).text)
      .join("");

    assert.match(stdout, /installing-deps/);
    assert.match(stderr, /a-warning/);

    // setup_log events must all precede the agent phase.
    const agentPhaseIdx = rows.findIndex((r) => r.type === "phase" && (r.payload as { phase: string }).phase === "agent");
    const lastSetupLogIdx = rows.map((r) => r.type).lastIndexOf("setup_log");
    assert.ok(lastSetupLogIdx < agentPhaseIdx, "setup output must be attributed to the setup phase");
  });

  it("fails the run visibly when the setup script fails", async () => {
    const { rows, fake } = await runTurn(
      [[upstream.delta("m1", "should never be asked"), upstream.done(10, 10)]],
      {},
      { setupScript: "echo could-not-resolve-dependency >&2; exit 7" },
    );

    assert.equal(fake.requests.length, 0, "the agent must not start if setup failed");
    const error = rows.find((r) => r.type === "error");
    assert.equal((error?.payload as { code: string }).code, "setup_failed");
    assert.match((error?.payload as { message: string }).message, /exited 7/);
    assert.equal((rows.at(-1)?.payload as { status: string }).status, "failed");
  });
});
