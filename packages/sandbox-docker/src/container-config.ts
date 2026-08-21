import type Docker from "dockerode";
import type { SandboxSpec } from "@codex-clone/core";
import { LABEL_KIND, LABEL_MANAGED, LABEL_MODE, LABEL_RUN_ID, LABEL_SANDBOX_ID, LABEL_TASK_ID, MANAGED_VALUE } from "./labels.js";

/**
 * Every isolation decision for a sandbox, in one pure function.
 *
 * It is pure on purpose: the flags below are the security boundary of this
 * product, so they are unit-tested without Docker (fast, always run in CI) AND
 * asserted against a live `docker inspect` in the integration test. A flag
 * that is only ever set in prose is a flag that quietly stops being set.
 */

/** Must match the uid created in docker/agent/Dockerfile. */
export const AGENT_UID = 10001;
export const AGENT_GID = 10001;

export const WORKSPACE_MOUNT = "/workspace";
export const CACHE_MOUNT = "/cache";
export const GATEWAY_MOUNT = "/run/gateway.sock";
export const JOB_SPEC_MOUNT = "/run/job.json";

export const KIND_SANDBOX = "sandbox";

/**
 * Env is readable by `docker inspect` and by every process the agent spawns,
 * so it is treated as a public surface. Anything that smells like a credential
 * is a hard error rather than a warning -- a warning would be ignored exactly
 * once, in the commit that leaks the key.
 */
const SECRET_LOOKING_ENV = /(?:^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|PAT|AUTH|APIKEY)(?:$|_)/i;

export class SecretInEnvError extends Error {
  constructor(name: string) {
    super(
      `Refusing to start a sandbox with env var "${name}": the sandbox holds zero credentials ` +
        `(PLAN.md section 3.3). Model calls go through the host gateway socket; GitHub access stays on the host.`,
    );
    this.name = "SecretInEnvError";
  }
}

export function assertNoSecretsInEnv(env: Record<string, string>): void {
  for (const name of Object.keys(env)) {
    if (SECRET_LOOKING_ENV.test(name)) throw new SecretInEnvError(name);
  }
}

export interface ContainerConfigInput {
  spec: SandboxSpec;
  sandboxId: string;
  containerName: string;
  /** Host path of the job-spec file, bind-mounted read-only at /run/job.json. */
  jobSpecHostPath: string;
  /** Diagnostic hook only. Production callers never set this; the image entrypoint is the agent. */
  overrideCommand?: string[];
}

export function buildContainerConfig(input: ContainerConfigInput): Docker.ContainerCreateOptions {
  const { spec, sandboxId, containerName, jobSpecHostPath, overrideCommand } = input;
  assertNoSecretsInEnv(spec.env);

  // ASK MODE IS STRUCTURAL. The read-only bit lives here, on the mount, not in
  // a system prompt. A jailbroken agent in ask mode gets EROFS from the kernel.
  const workspaceReadOnly = spec.mode === "ask";

  const mounts: Docker.MountSettings[] = [
    {
      Type: "volume",
      Source: spec.volumeName,
      Target: WORKSPACE_MOUNT,
      ReadOnly: workspaceReadOnly,
    },
  ];

  if (spec.cacheVolumeName) {
    // Known cross-workspace channel (PLAN.md section 3.7 accepted risk): a
    // hostile agent can poison this for the next task. Production splits it
    // per tenant.
    mounts.push({ Type: "volume", Source: spec.cacheVolumeName, Target: CACHE_MOUNT, ReadOnly: false });
  }

  /**
   * Host FILES go through `Binds`, not `Mounts`, and that is not a style
   * choice. Docker Desktop forwards a bind-mounted host unix socket through an
   * internal /socket_mnt path, and it only does that rewrite for `Binds`. The
   * identical mount expressed as `Mounts: [{Type:"bind", ...}]` is rejected
   * with "bind source path does not exist: /socket_mnt/...". Verified against
   * Docker Desktop 29.1.3; the gateway socket is the whole credential story,
   * so this stays as Binds.
   */
  const binds = [
    // The one hole in the sandbox, and it is deliberately a socket to a host
    // process that owns the credential -- not the credential itself.
    `${spec.gatewaySocketPath}:${GATEWAY_MOUNT}`,
    `${jobSpecHostPath}:${JOB_SPEC_MOUNT}:ro`,
  ];

  return {
    name: containerName,
    Image: spec.image,
    ...(overrideCommand ? { Cmd: overrideCommand, Entrypoint: [] } : {}),
    // Non-root, and pinned numerically so it cannot drift with the base image.
    User: `${AGENT_UID}:${AGENT_GID}`,
    WorkingDir: WORKSPACE_MOUNT,
    Env: buildEnv(spec),
    Labels: {
      [LABEL_MANAGED]: MANAGED_VALUE,
      [LABEL_KIND]: KIND_SANDBOX,
      [LABEL_SANDBOX_ID]: sandboxId,
      [LABEL_TASK_ID]: spec.taskId,
      [LABEL_RUN_ID]: spec.runId,
      [LABEL_MODE]: spec.mode,
    },
    // No TTY: we need a demultiplexed stream so stdout (the NDJSON event
    // channel) never interleaves with stderr diagnostics.
    Tty: false,
    OpenStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: {
      Mounts: mounts,
      Binds: binds,
      // Reap zombies: agent shell commands fork freely and pid 1 here is ours.
      Init: true,
      Privileged: false,
      // Drop the entire ambient capability set. The agent needs none of it --
      // it compiles code and edits files.
      CapDrop: ["ALL"],
      CapAdd: [],
      // Blocks setuid escalation even if the image ships a setuid binary.
      SecurityOpt: ["no-new-privileges"],
      /**
       * Supplementary group 0, for one specific reason: reaching the gateway
       * socket.
       *
       * Docker Desktop forwards a bind-mounted host unix socket through its VM
       * and re-creates it inside the container as root:root 0660, discarding
       * whatever mode the host set. A process running as uid 10001 with only
       * gid 10001 then gets EACCES on connect, and every model call fails.
       * Adding gid 0 as a SUPPLEMENTARY group makes the socket reachable while
       * the process stays uid 10001 with primary gid 10001 -- it is not root,
       * and with CapDrop ALL and a read-only rootfs, group 0 grants no
       * meaningful additional reach. Verified against Docker Desktop 29.1.3.
       */
      GroupAdd: ["0"],
      // Everything writable is an explicit mount: /workspace, /cache, /tmp.
      ReadonlyRootfs: true,
      Tmpfs: {
        // HOME lives here, so git/npm scratch writes land in RAM and vanish
        // with the container instead of persisting into the workspace.
        "/tmp": `rw,nosuid,nodev,size=${TMP_SIZE_MB}m`,
      },
      Memory: spec.limits.memoryMb * 1024 * 1024,
      // Equal to Memory => swap is disabled. Otherwise the memory cap is
      // advisory: a container simply swaps past it and thrashes the host.
      MemorySwap: spec.limits.memoryMb * 1024 * 1024,
      NanoCpus: Math.round(spec.limits.cpus * 1e9),
      // Fork-bomb guard. Agent-executed code is untrusted by definition.
      PidsLimit: spec.limits.pids,
      Ulimits: [{ Name: "nofile", Soft: 4096, Hard: 8192 }],
      // We remove containers explicitly in destroy(); auto-remove would race
      // the log reader and lose the tail of the transcript.
      AutoRemove: false,
      RestartPolicy: { Name: "no" },
      // Package-registry egress stays open (PLAN.md section 3.3): there is
      // nothing in the container worth exfiltrating. Production puts an
      // allowlist proxy here.
      NetworkMode: "bridge",
    },
  };
}

const TMP_SIZE_MB = 512;

function buildEnv(spec: SandboxSpec): string[] {
  // Base env is infrastructure only. Note what is absent: no OPENAI_API_KEY,
  // no GITHUB_TOKEN, no DATABASE_URL. There is nothing here to steal.
  const base: Record<string, string> = {
    HOME: "/tmp",
    // Read-only rootfs means the default cache locations would fail; point the
    // package managers at the shared cache volume.
    NPM_CONFIG_CACHE: `${CACHE_MOUNT}/npm`,
    PNPM_HOME: `${CACHE_MOUNT}/pnpm`,
    PIP_CACHE_DIR: `${CACHE_MOUNT}/pip`,
    XDG_CACHE_HOME: CACHE_MOUNT,
    AGENT_JOB_SPEC_PATH: JOB_SPEC_MOUNT,
    AGENT_GATEWAY_SOCKET: GATEWAY_MOUNT,
    AGENT_WORKSPACE: WORKSPACE_MOUNT,
  };
  const merged = { ...base, ...spec.env };
  return Object.entries(merged).map(([k, v]) => `${k}=${v}`);
}
