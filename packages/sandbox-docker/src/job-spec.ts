import type { SandboxMode } from "@codex-clone/core";

/**
 * The host -> container launch contract.
 *
 * `SandboxSpec` (frozen in @codex-clone/core) deliberately carries only
 * infrastructure: image, volume, socket, limits. It has no channel for the
 * *job* -- the prompt, the base SHA, the model. That is by design: the
 * provider seam should not know what an agent is. So the job travels
 * out-of-band, as a file the host writes and bind-mounts read-only at
 * /run/job.json.
 *
 * It is deliberately NOT passed as environment. Container env is readable via
 * `docker inspect` and by every process the agent spawns, so env is treated as
 * a hostile-readable surface throughout this package.
 *
 * `apps/agent-runtime` imports this type (type-only, so nothing from this
 * package is linked into the container bundle) and re-validates it at runtime,
 * because a file mounted into a sandbox is untrusted input at the point of
 * parse.
 */
export interface AgentJobSpec {
  taskId: string;
  runId: string;
  /** `ask` withholds apply_patch from the tool list; the mount is also read-only. */
  mode: SandboxMode;
  prompt: string;
  /** Pinned at task creation. The host derives every diff against this. */
  baseSha: string;
  /** Always /workspace today; explicit so the runtime never hardcodes a mount point. */
  workspacePath: string;
  model: string;
  /** In-container path of the bind-mounted gateway socket. */
  gatewaySocketPath: string;
  /** Repo install step, run as a distinct `setup` phase before the agent loop. */
  setupScript?: string;
  /**
   * First seq the runtime may emit. The event log is per-run and monotonic;
   * the host remains free to renumber on ingest.
   */
  seqStart: number;
  /** Hard stop inside the runtime. The gateway budget is the real bound. */
  maxTurns: number;
  /** Tool output above this is truncated, with `truncated` set honestly. */
  maxToolOutputBytes: number;
}

export const DEFAULT_JOB_SPEC_PATH = "/run/job.json";
export const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 16 * 1024;
