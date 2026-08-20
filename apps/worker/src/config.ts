import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BUDGET, DEFAULT_LIMITS } from "@codex-clone/core";

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  return raw === undefined ? fallback : Number(raw);
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
  dockerSocket: process.env.DOCKER_SOCKET ?? defaultDockerSocket,

  /** WebSocket hub. Lives in the worker because the worker sees events first. */
  wsPort: num("WORKER_WS_PORT", 8787),
  /** Local app: never bind to 0.0.0.0. */
  bindHost: env("BIND_HOST", "127.0.0.1"),

  /** Model-gateway unix socket, bind-mounted into every sandbox. */
  gatewaySocketPath: process.env.GATEWAY_SOCKET_PATH ?? join(dataDir(), "gateway.sock"),

  /** AES-256-GCM key for credentials at rest. Never committed, never logged. */
  encryptionKey: env("APP_ENCRYPTION_KEY"),

  agentImage: env("AGENT_IMAGE", "codex-clone/agent:dev"),
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
  return process.env.CODEX_DATA_DIR ?? join(homedir(), ".codexclone");
}
