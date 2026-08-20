import { randomUUID } from "node:crypto";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
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
import { LABEL_RUN_ID, LABEL_SANDBOX_ID, LABEL_TASK_ID, managedFilter } from "./labels.js";
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
  /** Container stderr is diagnostics, not transcript. Route it at the logging boundary. */
  onStderr?: (line: string, handle: SandboxHandle) => void;
}

export class ImageNotFoundError extends Error {
  constructor(image: string) {
    super(`Sandbox image "${image}" is not present locally. Build it with: pnpm agent:build`);
    this.name = "ImageNotFoundError";
  }
}

export class GatewaySocketMissingError extends Error {
  constructor(path: string) {
    super(
      `Model-gateway socket "${path}" does not exist. Start the worker gateway before creating a sandbox -- ` +
        `Docker would otherwise silently bind-mount a directory in its place and every model call would fail.`,
    );
    this.name = "GatewaySocketMissingError";
  }
}

export class DockerSandbox implements SandboxProvider {
  readonly docker: Docker;

  constructor(private readonly options: DockerSandboxOptions) {
    this.docker = new Docker({ socketPath: options.socketPath });
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
    await ensureVolume(this.docker, spec.volumeName, { kind: VOLUME_KIND_WORKSPACE, taskId: spec.taskId });
    if (spec.cacheVolumeName) {
      await ensureVolume(this.docker, spec.cacheVolumeName, { kind: VOLUME_KIND_CACHE });
    }

    const sandboxId = randomUUID();
    const jobSpecHostPath = await this.#writeJobSpec(sandboxId, full);

    try {
      const container = await this.docker.createContainer(
        buildContainerConfig({
          spec,
          sandboxId,
          containerName: `codex-sbx-${sandboxId.slice(0, 12)}`,
          jobSpecHostPath,
          ...(full.overrideCommand ? { overrideCommand: full.overrideCommand } : {}),
        }),
      );
      // A start that never returns would hold one of only three concurrency
      // slots forever and look identical to a sandbox that is working. Bound
      // it, and leave the container behind for `destroy` to clean up.
      await withTimeout(
        container.start(),
        this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
        `container ${container.id.slice(0, 12)} did not start`,
      );
      return { id: sandboxId, providerRef: container.id };
    } catch (err) {
      await unlink(jobSpecHostPath).catch(() => undefined);
      throw err;
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
  async list(): Promise<SandboxHandle[]> {
    const containers = await this.docker.listContainers({
      all: false,
      filters: managedFilter(KIND_SANDBOX),
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

  async #assertGatewaySocket(path: string): Promise<void> {
    try {
      const st = await stat(path);
      if (!st.isSocket()) throw new GatewaySocketMissingError(path);
    } catch (err) {
      if (err instanceof GatewaySocketMissingError) throw err;
      throw new GatewaySocketMissingError(path);
    }
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
