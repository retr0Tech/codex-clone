import { randomUUID } from "node:crypto";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import Docker from "dockerode";
import type {
  AnyEventRow,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
  StopOptions,
} from "@codex-clone/core";
import {
  KIND_SANDBOX,
  buildContainerConfig,
} from "./container-config.js";
import type { AgentJobSpec } from "./job-spec.js";
import { DEFAULT_MAX_TOOL_OUTPUT_BYTES } from "./job-spec.js";
import { FrameDemuxer } from "./demux.js";
import { DEFAULT_WORKSPACE_ID, LABEL_RUN_ID, LABEL_SANDBOX_ID, LABEL_TASK_ID, managedFilter } from "./labels.js";
import { NdjsonEventParser } from "./ndjson.js";
import { ensureVolume, isNotFound, VOLUME_KIND_CACHE, VOLUME_KIND_WORKSPACE } from "./volumes.js";

/**
 * The local implementation of the seam described in PLAN.md section 2.
 *
 * The orchestrator only ever calls create / attach / stop / destroy / list.
 * The agent loop runs INSIDE the container and speaks NDJSON on stdout, so
 * swapping this for Fargate or a Firecracker pool is a config change: nothing
 * above this file knows what a container is.
 */

/**
 * The job (prompt, base SHA, model) is not part of the frozen `SandboxSpec` --
 * that type is deliberately infrastructure-only. Callers pass it alongside, and
 * it is delivered to the container as a bind-mounted file, never as env.
 *
 * `DockerSandboxSpec` is assignable to `SandboxSpec`, so `create` still
 * satisfies the frozen interface exactly.
 */
export interface DockerSandboxSpec extends SandboxSpec {
  job: AgentJobSpecInput;
  /**
   * Diagnostic hook: replaces the image entrypoint. Used by the isolation
   * tests so they can assert the security flags on a container that just
   * sleeps. Production callers never set it.
   */
  overrideCommand?: string[];
}

export type AgentJobSpecInput = Omit<
  AgentJobSpec,
  "taskId" | "runId" | "mode" | "workspacePath" | "gatewaySocketPath" | "seqStart" | "maxTurns" | "maxToolOutputBytes"
> &
  Partial<Pick<AgentJobSpec, "seqStart" | "maxTurns" | "maxToolOutputBytes">>;

export interface DockerSandboxOptions {
  /** Always config.dockerSocket. /var/run/docker.sock may belong to another macOS user. */
  socketPath: string;
  /** Host directory for job-spec files. Created 0700; each file 0600. */
  jobSpecDir: string;
  /** Turn limit handed to the runtime when the caller does not specify one. */
  defaultMaxTurns?: number;
  /** Bound on `container.start()`, so a stalled daemon cannot hold a slot forever. */
  startTimeoutMs?: number;
  /** Attempts at create+start, to absorb Docker Desktop's async mount propagation. */
  startAttempts?: number;
  /** Container stderr is diagnostics, not transcript. Route it at the logging boundary. */
  onStderr?: (line: string, handle: SandboxHandle) => void;
  /**
   * Which checkout owns the containers and volumes this provider creates.
   *
   * `list()` -- and therefore boot reconciliation, which destroys every
   * managed sandbox no live run claims -- is scoped to it, so two workers
   * sharing one Docker daemon cannot tear down each other's containers.
   * Defaults to `default`, which is every single-workspace checkout.
   */
  workspaceId?: string;
}

export class ImageNotFoundError extends Error {
  constructor(image: string) {
    super(`Sandbox image "${image}" is not present locally. Build it with: pnpm agent:build`);
    this.name = "ImageNotFoundError";
  }
}

export class GatewaySocketMissingError extends Error {
  constructor(path: string, detail?: string) {
    super(
      `Model-gateway socket "${path}" is not ready${detail ? ` (${detail})` : ""}. ` +
        `Start the worker gateway and await its listening event before creating a sandbox -- ` +
        `Docker would otherwise bind-mount a directory in its place, or fail to start the container at all.`,
    );
    this.name = "GatewaySocketMissingError";
  }
}

/**
 * `container.start()` resolving does NOT mean the container is running.
 *
 * When the OCI runtime fails during init -- most commonly because a bind
 * source is not visible inside the Docker Desktop VM -- the daemon still
 * answers the start request successfully and records the failure on the
 * container instead, leaving it in `created` with `State.Error` set. Following
 * that container's logs then blocks forever, because a container that never
 * ran never closes its log stream.
 *
 * So a silent hang is the default failure mode here unless we explicitly go
 * and look. This error is what we surface instead.
 */
export class SandboxStartError extends Error {
  constructor(
    readonly containerId: string,
    readonly state: { Status?: string; ExitCode?: number; Error?: string },
  ) {
    const detail = state.Error?.trim();
    super(
      `Sandbox container ${containerId.slice(0, 12)} failed to start ` +
        `(status=${state.Status ?? "unknown"}, exitCode=${state.ExitCode ?? "unknown"})` +
        `${detail ? `: ${detail}` : ""}`,
    );
    this.name = "SandboxStartError";
  }
}

export class DockerSandbox implements SandboxProvider {
  readonly docker: Docker;
  readonly workspaceId: string;

  constructor(private readonly options: DockerSandboxOptions) {
    this.docker = new Docker({ socketPath: options.socketPath });
    this.workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const full = spec as DockerSandboxSpec;
    if (!full.job) {
      throw new TypeError("DockerSandbox.create requires a `job` alongside the SandboxSpec (see DockerSandboxSpec)");
    }

    await this.#assertImagePresent(spec.image);
    await this.#assertGatewaySocket(spec.gatewaySocketPath);

    // The volume is the hot tier and may already hold a cloned workspace from
    // a previous turn; createVolume is idempotent, so this is "ensure".
    await ensureVolume(this.docker, spec.volumeName, {
      kind: VOLUME_KIND_WORKSPACE,
      taskId: spec.taskId,
      workspaceId: this.workspaceId,
    });
    if (spec.cacheVolumeName) {
      // Deliberately NOT workspace-scoped: the package-manager cache is shared
      // on purpose (PLAN.md §3.7), and a per-workspace copy would multiply the
      // disk cost of the thing whose entire job is to avoid repeated downloads.
      await ensureVolume(this.docker, spec.cacheVolumeName, { kind: VOLUME_KIND_CACHE });
    }

    const sandboxId = randomUUID();
    const jobSpecHostPath = await this.#writeJobSpec(sandboxId, full);

    const startTimeoutMs = this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const attempts = Math.max(1, this.options.startAttempts ?? DEFAULT_START_ATTEMPTS);

    try {
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= attempts; attempt++) {
        const container = await this.docker.createContainer(
          buildContainerConfig({
            spec,
            sandboxId,
            // The name must be unique per attempt; a container left behind by
            // a failed start still owns its name until it is removed.
            containerName: `codex-sbx-${sandboxId.slice(0, 12)}${attempt > 1 ? `-r${attempt}` : ""}`,
            jobSpecHostPath,
            workspaceId: this.workspaceId,
            ...(full.overrideCommand ? { overrideCommand: full.overrideCommand } : {}),
          }),
        );

        try {
          // A start that never returns would hold one of only three
          // concurrency slots forever and look identical to a sandbox that is
          // working.
          await withTimeout(
            container.start(),
            startTimeoutMs,
            `container ${container.id.slice(0, 12)} did not start`,
          );
          // start() resolving is not proof of anything -- see SandboxStartError.
          await this.#assertLeftCreated(container, startTimeoutMs);
          return { id: sandboxId, providerRef: container.id };
        } catch (err) {
          await container.remove({ force: true, v: false }).catch(() => undefined);
          if (!isTransientMountFailure(err) || attempt === attempts) throw err;
          // Docker Desktop propagates the host filesystem into its VM
          // asynchronously, so a socket created milliseconds ago can still be
          // invisible to the OCI runtime even though it is listening and
          // connectable on the host. Retrying briefly closes that window;
          // anything that survives every attempt is a real fault and is thrown.
          lastError = err;
          await delay(RETRY_BACKOFF_MS * attempt);
        }
      }

      throw lastError ?? new Error("sandbox failed to start for an unknown reason");
    } catch (err) {
      await unlink(jobSpecHostPath).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Bounded, and it throws rather than waiting: `created` means the OCI
   * runtime never got the container off the ground, and no amount of further
   * waiting changes that. `exited` is fine -- a short command can finish
   * before the first poll.
   */
  async #assertLeftCreated(container: Docker.Container, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const info = await container.inspect();
      const state = info.State as {
        Status?: string;
        Running?: boolean;
        ExitCode?: number;
        Error?: string;
        StartedAt?: string;
      };

      const neverRan = !state.StartedAt || state.StartedAt.startsWith("0001-01-01");
      if (state.Error && state.Error.trim() !== "" && neverRan) {
        throw new SandboxStartError(container.id, state);
      }
      if (state.Running === true || state.Status === "exited" || state.Status === "dead") return;

      if (Date.now() >= deadline) throw new SandboxStartError(container.id, state);
      await delay(POLL_MS);
    }
  }

  /**
   * Durable events, parsed from the container's stdout.
   *
   * Uses `logs({follow})` rather than `attach` so a worker that restarts
   * mid-run can replay the whole stream from the start and rebuild its cursor
   * (PLAN.md section 7, risk 5). Stream faults become an `error` event rather
   * than a rejection: risk 4 says the failure mode must be a visible event,
   * never a hang.
   */
  async *attach(handle: SandboxHandle): AsyncIterable<AnyEventRow> {
    const container = this.docker.getContainer(handle.providerRef);
    const info = await container.inspect();

    // Never follow the logs of a container that has not run. Docker keeps that
    // stream open forever, so this would hang rather than fail -- which is how
    // a failed start turns into a test suite that never finishes.
    if (info.State.Status === "created") {
      throw new SandboxStartError(container.id, info.State as { Status?: string; ExitCode?: number; Error?: string });
    }

    const labels = info.Config.Labels ?? {};
    const parser = new NdjsonEventParser({
      runId: labels[LABEL_RUN_ID] ?? "",
      taskId: labels[LABEL_TASK_ID] ?? "",
    });

    // No `tail`: the default is the whole log, which is what a restarted
    // worker needs in order to replay and rebuild its cursor.
    const raw: NodeJS.ReadableStream = await container.logs({ follow: true, stdout: true, stderr: true });

    // Non-TTY container logs are frame-multiplexed; unpack before parsing, or
    // an 8-byte header lands in the middle of a JSON line. Done synchronously
    // rather than via dockerode's PassThrough-based demuxStream, so that the
    // source stream's `end` cannot outrun the final chunk -- which carries the
    // run's terminal `status` event.
    const demuxer = new FrameDemuxer();

    const queue: AnyEventRow[] = [];
    let done = false;
    let wake: (() => void) | null = null;
    const signal = () => {
      const w = wake;
      wake = null;
      w?.();
    };

    let stderrBuffer = "";
    raw.on("data", (chunk: Buffer) => {
      for (const frame of demuxer.push(chunk)) {
        if (frame.stream === "stderr") {
          // Diagnostics, not transcript: routed to the worker's logger (which
          // applies redaction) rather than into the durable event log.
          stderrBuffer += frame.data.toString("utf8");
          let idx: number;
          while ((idx = stderrBuffer.indexOf("\n")) !== -1) {
            const line = stderrBuffer.slice(0, idx);
            stderrBuffer = stderrBuffer.slice(idx + 1);
            if (line.trim()) this.options.onStderr?.(line, handle);
          }
        } else if (frame.stream === "stdout") {
          queue.push(...parser.push(frame.data));
        }
      }
      signal();
    });

    const finish = () => {
      if (done) return;
      queue.push(...parser.flush());
      done = true;
      signal();
    };
    raw.on("end", finish);
    raw.on("close", finish);
    raw.on("error", (err: Error) => {
      queue.push({
        seq: -1,
        runId: labels[LABEL_RUN_ID] ?? "",
        taskId: labels[LABEL_TASK_ID] ?? "",
        type: "error",
        payload: { code: "log_stream_failed", message: err.message, retryable: true },
        createdAt: new Date().toISOString(),
      });
      finish();
    });

    try {
      for (;;) {
        while (queue.length > 0) {
          yield queue.shift() as AnyEventRow;
        }
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      (raw as unknown as { destroy?: () => void }).destroy?.();
    }
  }

  /** SIGTERM, wait out the grace period, then SIGKILL. Same path as UI cancel. */
  async stop(handle: SandboxHandle, opts: StopOptions): Promise<void> {
    const container = this.docker.getContainer(handle.providerRef);
    const exited = container.wait().catch(() => undefined);

    try {
      await container.kill({ signal: "SIGTERM" });
    } catch (err) {
      // 404 => already gone; 409 => not running. Both mean "stopped".
      if (!isNotFound(err) && !isConflict(err)) throw err;
      return;
    }

    const timedOut = Symbol("timeout");
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), opts.graceMs);
    });
    const winner = await Promise.race([exited.then(() => "exited" as const), grace]);
    clearTimeout(timer);

    if (winner === timedOut) {
      await container.kill({ signal: "SIGKILL" }).catch((err: unknown) => {
        if (!isNotFound(err) && !isConflict(err)) throw err;
      });
      await exited;
    }
  }

  /**
   * Removes the container and its job-spec file. Deliberately does NOT touch
   * the workspace volume: the volume IS the live state between turns, and
   * dropping it here would make every follow-up a cold restore. Volume removal
   * is the idle reaper's job, after a cold snapshot exists.
   */
  async destroy(handle: SandboxHandle): Promise<void> {
    const container = this.docker.getContainer(handle.providerRef);
    try {
      await container.remove({ force: true, v: false });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    await unlink(this.#jobSpecPath(handle.id)).catch(() => undefined);
  }

  /** Worker-boot reconciliation: which sandboxes did we leave running? */
  /**
   * Live sandboxes belonging to THIS workspace.
   *
   * The workspace scope is load-bearing rather than cosmetic: the caller
   * (RunQueue.reconcile) destroys every sandbox it sees that no run in its own
   * database claims, so an unscoped list would make a second worker's
   * containers look like orphans.
   */
  async list(): Promise<SandboxHandle[]> {
    const containers = await this.docker.listContainers({
      all: false,
      filters: managedFilter(KIND_SANDBOX, this.workspaceId),
    });
    return containers
      .map((c) => ({ id: c.Labels?.[LABEL_SANDBOX_ID] ?? "", providerRef: c.Id }))
      .filter((h) => h.id !== "");
  }

  async #assertImagePresent(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
    } catch (err) {
      if (isNotFound(err)) throw new ImageNotFoundError(image);
      throw err;
    }
  }

  /**
   * The socket must exist AND have something listening on it before the
   * container is created.
   *
   * A stat alone is not enough: the file can be on disk while the server is
   * still binding, and Docker Desktop resolves the bind at container-start
   * time. A real connect is the only check that proves the far end is
   * accepting, and it costs a millisecond.
   */
  async #assertGatewaySocket(path: string): Promise<void> {
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(path);
    } catch (err) {
      throw new GatewaySocketMissingError(path, (err as NodeJS.ErrnoException).code ?? "stat failed");
    }
    if (!st.isSocket()) throw new GatewaySocketMissingError(path, "path exists but is not a socket");

    await new Promise<void>((resolve, reject) => {
      const probe = connect(path);
      const done = (err?: Error) => {
        probe.destroy();
        clearTimeout(timer);
        if (err) reject(new GatewaySocketMissingError(path, `nothing is listening (${err.message})`));
        else resolve();
      };
      const timer = setTimeout(() => done(new Error(`connect timed out after ${SOCKET_PROBE_MS}ms`)), SOCKET_PROBE_MS);
      probe.once("connect", () => done());
      probe.once("error", (err: Error) => done(err));
    });
  }

  #jobSpecPath(sandboxId: string): string {
    return join(this.options.jobSpecDir, `${sandboxId}.json`);
  }

  async #writeJobSpec(sandboxId: string, spec: DockerSandboxSpec): Promise<string> {
    await mkdir(this.options.jobSpecDir, { recursive: true, mode: 0o700 });
    const job: AgentJobSpec = {
      taskId: spec.taskId,
      runId: spec.runId,
      mode: spec.mode,
      prompt: spec.job.prompt,
      baseSha: spec.job.baseSha,
      workspacePath: "/workspace",
      model: spec.job.model,
      gatewaySocketPath: "/run/gateway.sock",
      ...(spec.job.setupScript ? { setupScript: spec.job.setupScript } : {}),
      seqStart: spec.job.seqStart ?? 0,
      maxTurns: spec.job.maxTurns ?? this.options.defaultMaxTurns ?? 40,
      maxToolOutputBytes: spec.job.maxToolOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES,
    };
    const path = this.#jobSpecPath(sandboxId);
    await writeFile(path, `${JSON.stringify(job)}\n`, { mode: 0o600 });
    return path;
  }
}

function isConflict(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { statusCode?: number }).statusCode === 409;
}

/** Two minutes: enough for a cold image on a loaded laptop, short of forever. */
export const DEFAULT_START_TIMEOUT_MS = 120_000;
/** Retries exist only to absorb Docker Desktop's async host-mount propagation. */
export const DEFAULT_START_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 150;
const POLL_MS = 25;
const SOCKET_PROBE_MS = 2_000;

/**
 * A start failure caused by a bind source the OCI runtime could not open.
 *
 * On Docker Desktop this is usually transient: the host filesystem is
 * propagated into the VM asynchronously, so a socket or file created
 * milliseconds ago may not be visible inside the VM yet -- even though it
 * exists, is listening, and is connectable from the host. Anything else (a
 * genuinely missing path, a permission problem) fails identically on every
 * attempt and surfaces after the last one.
 *
 * The daemon reports this two different ways depending on where it notices:
 * as a rejected start call, or as an error recorded on a container left in
 * `created`. Both shapes are matched here.
 */
function isTransientMountFailure(err: unknown): boolean {
  const parts: string[] = [];
  if (err instanceof SandboxStartError) parts.push(err.state.Error ?? "");
  if (err instanceof Error) parts.push(err.message);
  const json = (err as { json?: { message?: unknown } } | null)?.json?.message;
  if (typeof json === "string") parts.push(json);

  const message = parts.join(" ").toLowerCase();
  return (
    message.includes("no such file or directory") &&
    (message.includes("mount") || message.includes("socket_mnt") || message.includes("container init"))
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${message} within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
