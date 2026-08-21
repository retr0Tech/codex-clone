import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LIMITS, type SandboxSpec } from "@codex-clone/core";
import {
  AGENT_GID,
  AGENT_UID,
  assertNoSecretsInEnv,
  buildContainerConfig,
  SecretInEnvError,
} from "./container-config.js";

/**
 * These flags are the security boundary of the product, so they are asserted
 * here with no Docker (always runs, including in CI) and again against a live
 * `docker inspect` in docker-sandbox.int.test.ts.
 */

function spec(over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    taskId: "task_1",
    runId: "run_1",
    image: "codex-clone/agent:dev",
    mode: "code",
    volumeName: "ws-task_1",
    gatewaySocketPath: "/host/gateway.sock",
    limits: DEFAULT_LIMITS,
    env: {},
    ...over,
  };
}

function build(over: Partial<SandboxSpec> = {}) {
  return buildContainerConfig({
    spec: spec(over),
    sandboxId: "sbx-1",
    containerName: "codex-sbx-1",
    jobSpecHostPath: "/host/jobs/sbx-1.json",
  });
}

describe("buildContainerConfig isolation", () => {
  it("drops every capability and forbids privilege escalation", () => {
    const cfg = build();
    assert.deepEqual(cfg.HostConfig?.CapDrop, ["ALL"]);
    assert.deepEqual(cfg.HostConfig?.CapAdd, []);
    assert.deepEqual(cfg.HostConfig?.SecurityOpt, ["no-new-privileges"]);
    assert.equal(cfg.HostConfig?.Privileged, false);
  });

  it("runs as a non-root uid pinned numerically", () => {
    assert.notEqual(AGENT_UID, 0);
    assert.equal(build().User, `${AGENT_UID}:${AGENT_UID}`);
  });

  it("adds group 0 for socket access only -- the uid and primary gid stay non-root", () => {
    const cfg = build();
    // Docker Desktop re-creates the forwarded gateway socket as root:root 0660
    // inside the container, so the agent needs gid 0 to connect to it.
    assert.deepEqual(cfg.HostConfig?.GroupAdd, ["0"]);
    // But it must remain a non-root process: uid 10001, primary gid 10001.
    assert.equal(cfg.User, `${AGENT_UID}:${AGENT_GID}`);
    assert.notEqual(cfg.User, "0:0");
    assert.notEqual(AGENT_GID, 0);
  });

  it("makes the root filesystem read-only with a tmpfs for /tmp", () => {
    const cfg = build();
    assert.equal(cfg.HostConfig?.ReadonlyRootfs, true);
    assert.match(String(cfg.HostConfig?.Tmpfs?.["/tmp"]), /rw,nosuid,nodev,size=\d+m/);
  });

  it("applies memory, cpu and pid limits, and disables swap escape", () => {
    const cfg = build({ limits: { memoryMb: 1024, cpus: 1.5, pids: 128, wallClockMs: 1000 } });
    assert.equal(cfg.HostConfig?.Memory, 1024 * 1024 * 1024);
    assert.equal(cfg.HostConfig?.MemorySwap, cfg.HostConfig?.Memory, "MemorySwap must equal Memory or the cap is advisory");
    assert.equal(cfg.HostConfig?.NanoCpus, 1_500_000_000);
    assert.equal(cfg.HostConfig?.PidsLimit, 128);
  });

  it("never mounts the docker socket", () => {
    const cfg = build({ cacheVolumeName: "agent-cache" });
    const all = [
      ...(cfg.HostConfig?.Mounts ?? []).map((m) => `${m.Source}->${m.Target}`),
      ...(cfg.HostConfig?.Binds ?? []),
    ];
    assert.equal(
      all.some((t) => t.includes("docker.sock")),
      false,
      `a docker socket mount is a container escape: ${all.join(", ")}`,
    );
  });

  it("mounts the workspace read-write in code mode", () => {
    const ws = build({ mode: "code" }).HostConfig?.Mounts?.find((m) => m.Target === "/workspace");
    assert.equal(ws?.ReadOnly, false);
  });

  it("mounts the workspace READ-ONLY in ask mode -- structural, not prompted", () => {
    const ws = build({ mode: "ask" }).HostConfig?.Mounts?.find((m) => m.Target === "/workspace");
    assert.equal(ws?.ReadOnly, true);
  });

  it("bind-mounts the gateway socket and the job spec, the latter read-only", () => {
    // Host files go through Binds, not Mounts: Docker Desktop only applies its
    // unix-socket forwarding to Binds. See the comment in container-config.ts.
    const binds = build().HostConfig?.Binds ?? [];
    assert.ok(binds.includes("/host/gateway.sock:/run/gateway.sock"), `gateway socket missing from ${binds.join(", ")}`);
    assert.ok(binds.includes("/host/jobs/sbx-1.json:/run/job.json:ro"), `job spec must be mounted read-only`);
  });

  it("keeps the job spec out of env entirely", () => {
    const env = build().Env ?? [];
    assert.equal(
      env.some((e) => e.includes("integration test") || /PROMPT=/i.test(e)),
      false,
      "the job must travel as a mounted file, never as env",
    );
  });

  it("omits the cache mount when no cache volume is configured", () => {
    assert.equal(
      (build().HostConfig?.Mounts ?? []).some((m) => m.Target === "/cache"),
      false,
    );
  });

  it("carries no credentials in env", () => {
    const env = build().Env ?? [];
    for (const forbidden of ["OPENAI_API_KEY", "GITHUB_TOKEN", "DATABASE_URL", "APP_ENCRYPTION_KEY"]) {
      assert.equal(
        env.some((e) => e.startsWith(`${forbidden}=`)),
        false,
        `${forbidden} must never reach the sandbox`,
      );
    }
    assert.equal(
      env.some((e) => e === "AGENT_JOB_SPEC_PATH=/run/job.json"),
      true,
    );
  });

  it("disables auto-remove so the tail of the transcript survives exit", () => {
    assert.equal(build().HostConfig?.AutoRemove, false);
  });

  it("allocates no TTY, so stdout and stderr stay separable", () => {
    assert.equal(build().Tty, false);
  });
});

describe("assertNoSecretsInEnv", () => {
  for (const name of ["OPENAI_API_KEY", "GITHUB_TOKEN", "MY_SECRET", "DB_PASSWORD", "GH_PAT", "AUTH_HEADER"]) {
    it(`rejects ${name}`, () => {
      assert.throws(() => assertNoSecretsInEnv({ [name]: "x" }), SecretInEnvError);
    });
  }

  it("allows ordinary configuration", () => {
    assert.doesNotThrow(() => assertNoSecretsInEnv({ NODE_ENV: "production", CI: "true", LANG: "C.UTF-8" }));
  });

  it("refuses to build a container config with a secret-looking env var", () => {
    assert.throws(() => build({ env: { OPENAI_API_KEY: "sk-not-a-real-key" } }), SecretInEnvError);
  });
});
