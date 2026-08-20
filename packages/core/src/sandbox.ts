import type { AnyEventRow } from "./events.js";

/**
 * The seam that carries the cloud-migration story.
 *
 * `DockerSandbox` implements this locally today; a Fargate or Firecracker
 * implementation swaps in without the orchestrator changing, because the agent
 * loop runs INSIDE the sandbox and streams NDJSON on stdout. The orchestrator
 * only ever does create / attach / stop / destroy.
 */

export interface ResourceLimits {
  memoryMb: number;
  cpus: number;
  /** Guards against fork bombs from agent-executed code. */
  pids: number;
  wallClockMs: number;
}

export const DEFAULT_LIMITS: ResourceLimits = {
  memoryMb: 2048,
  cpus: 2,
  pids: 512,
  wallClockMs: 20 * 60 * 1000,
};

/**
 * `ask` mounts the workspace read-only and withholds the apply_patch tool.
 * Read-only mode is enforced structurally, not by prompt text, so a jailbroken
 * agent still cannot write.
 */
export type SandboxMode = "ask" | "code";

export interface SandboxSpec {
  taskId: string;
  runId: string;
  image: string;
  mode: SandboxMode;
  /** Hot-tier Docker volume holding /workspace. Survives between turns. */
  volumeName: string;
  /**
   * Host path of the model-gateway unix socket, bind-mounted to
   * /run/gateway.sock. This is how the sandbox reaches OpenAI WITHOUT ever
   * holding the API key.
   */
  gatewaySocketPath: string;
  /** Shared package-manager cache mount. Known cross-workspace channel. */
  cacheVolumeName?: string;
  /** Repo-configured install step, run as its own visible phase before the agent. */
  setupScript?: string;
  limits: ResourceLimits;
  /**
   * Non-sensitive environment only. Secrets MUST NOT be passed here -- env is
   * readable via `docker inspect` and by any code the agent executes.
   */
  env: Record<string, string>;
}

export interface SandboxHandle {
  /** Stable id we assign, used as the DB foreign key. */
  id: string;
  /** Provider-specific reference (container id, task ARN, vm id). */
  providerRef: string;
}

export interface StopOptions {
  /** SIGTERM, then SIGKILL after this grace period. */
  graceMs: number;
  reason: string;
}

export interface SandboxProvider {
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  /** Parsed NDJSON from the agent's stdout, as durable event rows. */
  attach(handle: SandboxHandle): AsyncIterable<AnyEventRow>;
  /** Graceful wind-down; resolves once the process has exited. */
  stop(handle: SandboxHandle, opts: StopOptions): Promise<void>;
  /** Removes the container. Does NOT remove the hot volume. */
  destroy(handle: SandboxHandle): Promise<void>;
  /** Reconciliation on worker boot: which sandboxes are still alive? */
  list(): Promise<SandboxHandle[]>;
}
