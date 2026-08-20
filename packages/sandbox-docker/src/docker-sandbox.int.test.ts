import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import Docker from "dockerode";
import { DEFAULT_LIMITS, type SandboxHandle, type SandboxSpec } from "@codex-clone/core";
import { AGENT_UID } from "./container-config.js";
import type { DockerSandboxSpec } from "./docker-sandbox.js";
import { DockerSandbox } from "./docker-sandbox.js";
import { acquireDockerTestLock, type DockerTestLock } from "./test-lock.js";
import { removeVolume, volumeExists } from "./volumes.js";

/**
 * The isolation flags asserted here are asserted against a LIVE container, via
 * `docker inspect` and by actually attempting the writes that must fail.
 *
 * container-config.test.ts already proves we ASK Docker for the right flags.
 * This file proves Docker APPLIED them -- which is the part that silently
 * stops being true when a flag is renamed, ignored on a new engine version, or
 * quietly overridden by a daemon default.
 *
 * Skips cleanly with a reason when Docker or the image is absent (CI has
 * neither).
 */

const IMAGE = process.env["AGENT_IMAGE"] ?? "codex-clone/agent:dev";
const SOCKET = process.env["DOCKER_SOCKET"] ?? join(homedir(), ".docker", "run", "docker.sock");

async function unavailableReason(): Promise<string | false> {
  const docker = new Docker({ socketPath: SOCKET });
  try {
    await docker.ping();
  } catch (err) {
    return `Docker is not reachable at ${SOCKET} (${(err as Error).message}); skipping sandbox integration tests`;
  }
  try {
    await docker.getImage(IMAGE).inspect();
  } catch {
    return `sandbox image "${IMAGE}" is not built; run \`pnpm agent:build\` to enable these tests`;
  }
  return false;
}

const skip = await unavailableReason();

describe("DockerSandbox against a live daemon", { skip: skip === false ? undefined : skip }, () => {
  let docker: Docker;
  let sandbox: DockerSandbox;
  let hostDir: string;
  let gateway: Server;
  let gatewaySocketPath: string;
  const created: SandboxHandle[] = [];
  const volumes: string[] = [];
  let lock: DockerTestLock;

  before(async () => {
    // Only one Docker-dependent suite at a time; see test-lock.ts.
    lock = await acquireDockerTestLock();
    docker = new Docker({ socketPath: SOCKET });
    // Under the home directory, not os.tmpdir(): Docker Desktop's file-sharing
    // allowlist covers /Users but not /private/var/folders, and a bind mount
    // from outside the allowlist fails with a fairly opaque /socket_mnt error.
    // This is also where the real gateway socket lives (config.dataDir), so the
    // test exercises the same path the worker will.
    hostDir = await realpath(await mkdtemp(join(homedir(), ".codexclone-inttest-")));
    sandbox = makeSandbox();

    // A gateway that accepts and says nothing. Enough to prove the socket is
    // bind-mounted as a socket; no model call is made anywhere in this file.
    gatewaySocketPath = join(hostDir, "gateway.sock");
    gateway = createServer();
    await new Promise<void>((resolve) => gateway.listen(gatewaySocketPath, resolve));
  });

  after(async () => {
    for (const handle of created) await sandbox.destroy(handle).catch(() => undefined);
    for (const volume of volumes) await removeVolume(docker, volume, { force: true }).catch(() => undefined);
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await rm(hostDir, { recursive: true, force: true });
    await lock.release();
  });

  function makeSandbox(): DockerSandbox {
    return new DockerSandbox({ socketPath: SOCKET, jobSpecDir: join(hostDir, "jobs") });
  }

  function spec(over: Partial<SandboxSpec> = {}, job: Partial<DockerSandboxSpec["job"]> = {}): DockerSandboxSpec {
    const taskId = `t-${randomUUID().slice(0, 8)}`;
    const volumeName = `codex-int-${taskId}`;
    volumes.push(volumeName);
    return {
      taskId,
      runId: `r-${randomUUID().slice(0, 8)}`,
      image: IMAGE,
      mode: "code",
      volumeName,
      gatewaySocketPath,
      limits: { ...DEFAULT_LIMITS, memoryMb: 512, cpus: 1, pids: 128 },
      env: {},
      job: { prompt: "integration test", baseSha: "0".repeat(40), model: "gpt-5", ...job },
      ...over,
    };
  }

  async function launch(over: Partial<SandboxSpec> = {}, command = ["sleep", "300"]): Promise<SandboxHandle> {
    const handle = await sandbox.create({ ...spec(over), overrideCommand: command } as SandboxSpec);
    created.push(handle);
    return handle;
  }

  /** Runs a command inside a live sandbox and returns its exit code and output. */
  async function exec(handle: SandboxHandle, cmd: string[]): Promise<{ code: number; output: string }> {
    const container = docker.getContainer(handle.providerRef);
    const e = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
    const stream = await e.start({ hijack: true, stdin: false });
    let output = "";
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => {
        // Frame-multiplexed: strip the 8-byte headers.
        let offset = 0;
        while (offset + 8 <= chunk.length) {
          const size = chunk.readUInt32BE(offset + 4);
          output += chunk.subarray(offset + 8, offset + 8 + size).toString("utf8");
          offset += 8 + size;
        }
      });
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    const info = await e.inspect();
    return { code: info.ExitCode ?? -1, output: output.trim() };
  }

  it("applies every isolation flag to the live container", async () => {
    const handle = await launch();
    const info = await docker.getContainer(handle.providerRef).inspect();
    const host = info.HostConfig;

    assert.deepEqual(host.CapDrop, ["ALL"], "all capabilities must be dropped");
    assert.deepEqual(host.SecurityOpt, ["no-new-privileges"], "setuid escalation must be blocked");
    assert.equal(host.ReadonlyRootfs, true, "root filesystem must be read-only");
    assert.equal(host.Privileged, false);
    assert.equal(host.Memory, 512 * 1024 * 1024);
    assert.equal(host.MemorySwap, 512 * 1024 * 1024, "swap must be disabled or the memory cap is advisory");
    assert.equal(host.NanoCpus, 1_000_000_000);
    assert.equal(host.PidsLimit, 128);
    assert.equal(info.Config.User, `${AGENT_UID}:${AGENT_UID}`);
    assert.notEqual(info.Config.User, "0:0");

    // The container must have no route to the daemon that runs it.
    const mountSources = info.Mounts.map((m) => `${m.Source ?? ""} -> ${m.Destination}`);
    assert.equal(
      mountSources.some((m) => m.includes("docker.sock")),
      false,
      `docker socket is mounted, which is a container escape: ${mountSources.join(", ")}`,
    );

    // And no credentials in env, which `docker inspect` would expose anyway.
    for (const forbidden of ["OPENAI_API_KEY", "GITHUB_TOKEN", "APP_ENCRYPTION_KEY", "DATABASE_URL"]) {
      assert.equal(
        (info.Config.Env ?? []).some((e) => e.startsWith(`${forbidden}=`)),
        false,
        `${forbidden} leaked into the sandbox env`,
      );
    }
  });

  it("really runs as a non-root user with no capabilities", async () => {
    const handle = await launch();

    const id = await exec(handle, ["id", "-u"]);
    assert.equal(id.output, String(AGENT_UID));

    // Group 0 is present only so the forwarded gateway socket is reachable;
    // the process itself must still be uid 10001, not root.
    const gid = await exec(handle, ["id", "-g"]);
    assert.equal(gid.output, String(AGENT_UID));

    // CapEff is the effective capability set; 0 means every one was dropped.
    const caps = await exec(handle, ["sh", "-c", "grep CapEff /proc/self/status"]);
    assert.match(caps.output, /CapEff:\s+0000000000000000/, `expected an empty capability set, got: ${caps.output}`);
  });

  it("really enforces the read-only root filesystem", async () => {
    const handle = await launch();

    const etc = await exec(handle, ["sh", "-c", "touch /etc/pwned 2>&1"]);
    assert.notEqual(etc.code, 0, "writing to /etc must fail");
    assert.match(etc.output, /Read-only file system/);

    // /tmp is the one writable place on the rootfs, because HOME lives there.
    const tmp = await exec(handle, ["sh", "-c", "touch /tmp/ok && echo wrote"]);
    assert.equal(tmp.code, 0);
    assert.equal(tmp.output, "wrote");
  });

  it("mounts the workspace writable in code mode", async () => {
    const handle = await launch({ mode: "code" });
    const res = await exec(handle, ["sh", "-c", "touch /workspace/probe && echo wrote"]);
    assert.equal(res.code, 0, `code mode must be writable, got: ${res.output}`);
    assert.equal(res.output, "wrote");
  });

  it("ASK MODE: really prevents writes to the workspace, without any prompt", async () => {
    const handle = await launch({ mode: "ask" });

    const info = await docker.getContainer(handle.providerRef).inspect();
    const ws = info.Mounts.find((m) => m.Destination === "/workspace");
    assert.equal(ws?.RW, false, "ask mode must mount /workspace read-only");

    const res = await exec(handle, ["sh", "-c", "touch /workspace/pwned 2>&1"]);
    assert.notEqual(res.code, 0, "ask mode must reject writes at the kernel, not by asking nicely");
    assert.match(res.output, /Read-only file system/);
  });

  it("bind-mounts the job spec read-only, and never passes it via env", async () => {
    const handle = await launch({}, ["sleep", "300"]);

    const job = await exec(handle, ["cat", "/run/job.json"]);
    assert.equal(job.code, 0);
    const parsed = JSON.parse(job.output) as { prompt: string; baseSha: string };
    assert.equal(parsed.prompt, "integration test");

    const write = await exec(handle, ["sh", "-c", "echo x > /run/job.json 2>&1"]);
    assert.notEqual(write.code, 0, "the job spec must be read-only inside the container");

    const env = await exec(handle, ["sh", "-c", "env | grep -i prompt || echo none"]);
    assert.equal(env.output, "none", "the prompt must never appear in env");
  });

  it("bind-mounts the gateway as a socket the agent can actually connect to", async () => {
    const handle = await launch();
    const res = await exec(handle, ["sh", "-c", "[ -S /run/gateway.sock ] && echo socket || echo missing"]);
    assert.equal(res.output, "socket");
  });

  it("streams parsed NDJSON events, and a malformed line does not kill the stream", async () => {
    const stdoutLines = [
      JSON.stringify({ seq: 0, type: "phase", payload: { phase: "setup" } }),
      JSON.stringify({ seq: 1, type: "setup_log", payload: { stream: "stdout", text: "installing\n" } }),
      "OOPS not json at all",
      JSON.stringify({ seq: 2, type: "status", payload: { status: "succeeded" } }),
    ].join("\n");

    // Split mid-way through the FIRST JSON object and pause, so the parser has
    // to hold a partial line across a real chunk boundary rather than a
    // simulated one.
    const splitAt = 20;
    const script = [
      `process.stdout.write(${JSON.stringify(stdoutLines.slice(0, splitAt))});`,
      "setTimeout(() => {",
      `  process.stdout.write(${JSON.stringify(`${stdoutLines.slice(splitAt)}\n`)});`,
      `  process.stderr.write(${JSON.stringify("diagnostics go to stderr\n")});`,
      "}, 60);",
    ].join("\n");

    const stderrLines: string[] = [];
    const provider = new DockerSandbox({
      socketPath: SOCKET,
      jobSpecDir: join(hostDir, "jobs"),
      onStderr: (line) => stderrLines.push(line),
    });
    const handle = await provider.create({ ...spec(), overrideCommand: ["node", "-e", script] } as SandboxSpec);
    created.push(handle);

    const rows = [];
    for await (const row of provider.attach(handle)) rows.push(row);

    assert.deepEqual(
      rows.map((r) => r.type),
      ["phase", "setup_log", "error", "status"],
    );
    assert.equal((rows[2]?.payload as { code: string }).code, "bad_json");
    // Ids come from the container labels, not from anything the agent claimed.
    for (const row of rows) assert.notEqual(row.runId, "");
    assert.deepEqual(stderrLines, ["diagnostics go to stderr"]);
  });

  it("escalates to SIGKILL when the process ignores SIGTERM", async () => {
    // A container that traps and ignores TERM is exactly the case the grace
    // period exists for.
    const handle = await launch({}, ["bash", "-c", "trap '' TERM; sleep 300"]);
    const startedAt = Date.now();

    await sandbox.stop(handle, { graceMs: 1500, reason: "integration test" });
    const elapsed = Date.now() - startedAt;

    const info = await docker.getContainer(handle.providerRef).inspect();
    assert.equal(info.State.Running, false, "container must be stopped");
    assert.ok(elapsed >= 1500, `must wait out the grace period before SIGKILL, waited ${elapsed}ms`);
    assert.ok(elapsed < 15_000, `must not wait indefinitely, waited ${elapsed}ms`);
  });

  it("lists live sandboxes for worker-boot reconciliation", async () => {
    const handle = await launch();
    const listed = await sandbox.list();
    assert.ok(
      listed.some((h) => h.id === handle.id && h.providerRef === handle.providerRef),
      "list() must report the sandbox we just created",
    );
  });

  it("destroy removes the container but KEEPS the workspace volume", async () => {
    const provider = makeSandbox();
    const s = spec();
    const handle = await provider.create({ ...s, overrideCommand: ["sleep", "300"] } as SandboxSpec);

    assert.equal(await volumeExists(docker, s.volumeName), true);
    await provider.destroy(handle);

    await assert.rejects(
      docker.getContainer(handle.providerRef).inspect(),
      "the container must be gone after destroy()",
    );
    assert.equal(
      await volumeExists(docker, s.volumeName),
      true,
      "the hot volume IS the live state between turns; destroy() must never remove it",
    );
    assert.equal(
      (await provider.list()).some((h) => h.id === handle.id),
      false,
    );
  });
});
