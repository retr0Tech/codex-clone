import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BUDGET, DEFAULT_LIMITS } from "@codex-clone/core";

/**
 * Reads an environment variable, treating an EMPTY value as absent.
 *
 * A .env file commonly carries placeholder keys with nothing after the `=`
 * (see .env.example). Using `??` alone would accept "" as a real value, which
 * silently produced a relative gateway socket path from an empty
 * CODEX_DATA_DIR. Blank means "not set", not "set to nothing".
 */
function raw(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v.trim() === "" ? undefined : v;
}

function env(key: string, fallback?: string): string {
  const v = raw(key) ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function num(key: string, fallback: number): number {
  const v = raw(key);
  if (v === undefined) return fallback;
  const parsed = Number(v);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Env var ${key} must be a number, got: ${v}`);
  }
  return parsed;
}

/**
 * Docker Desktop exposes a per-user socket. On a machine where another account
 * installed Docker first, /var/run/docker.sock is a symlink into THAT user's
 * home and is unreadable here -- so we address the socket explicitly rather
 * than relying on the default.
 */
const defaultDockerSocket = join(homedir(), ".docker", "run", "docker.sock");

export const config = {
  databaseUrl: env("DATABASE_URL", "postgres://codex:codex@localhost:5432/codex_clone"),
  dockerSocket: raw("DOCKER_SOCKET") ?? defaultDockerSocket,

  /** WebSocket hub. Lives in the worker because the worker sees events first. */
  wsPort: num("WORKER_WS_PORT", 8787),
  /** Local app: never bind to 0.0.0.0. */
  bindHost: env("BIND_HOST", "127.0.0.1"),

  /** Model-gateway unix socket, bind-mounted into every sandbox. */
  gatewaySocketPath: raw("GATEWAY_SOCKET_PATH") ?? join(dataDir(), "gateway.sock"),

  /** AES-256-GCM key for credentials at rest. Never committed, never logged. */
  encryptionKey: env("APP_ENCRYPTION_KEY"),

  agentImage: env("AGENT_IMAGE", "codex-clone/agent:dev"),
  /**
   * Shared package-manager cache, mounted into every sandbox at /cache so a
   * repeated `npm ci` is warm (PLAN.md §3.7). This is a known cross-workspace
   * channel -- a hostile agent can poison it for the next task -- and the
   * production fix is a per-tenant namespace. Set to empty to disable it.
   */
  cacheVolumeName: raw("CACHE_VOLUME_NAME") ?? "codex-clone-cache",
  maxConcurrentSandboxes: num("MAX_CONCURRENT_SANDBOXES", 3),
  /** Container is reaped to the cold snapshot store after this much idle time. */
  idleReapMs: num("IDLE_REAP_MS", 15 * 60 * 1000),
  schedulerTickMs: num("SCHEDULER_TICK_MS", 30_000),
  stopGraceMs: num("STOP_GRACE_MS", 10_000),

  limits: DEFAULT_LIMITS,
  budget: DEFAULT_BUDGET,

  dataDir: dataDir(),
  mirrorsDir: join(dataDir(), "mirrors"),
  snapshotsDir: join(dataDir(), "snapshots"),
} as const;

function dataDir(): string {
  return raw("CODEX_DATA_DIR") ?? join(homedir(), ".codexclone");
}
