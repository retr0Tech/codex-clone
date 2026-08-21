import { connect } from "node:net";
import Docker from "dockerode";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Availability probes for the integration suites.
 *
 * Every probe here is BOUNDED and returns a reason rather than throwing. CI has
 * neither Docker nor Postgres, and a suite that hangs waiting for one of them
 * is strictly worse than a suite that skips with an explanation -- a hang is
 * indistinguishable from a deadlock in the code under test.
 */

export const TEST_IMAGE = process.env["AGENT_IMAGE"] ?? "codex-clone/agent:dev";
export const TEST_DOCKER_SOCKET =
  process.env["DOCKER_SOCKET"] ?? join(homedir(), ".docker", "run", "docker.sock");
export const TEST_DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgres://codex:codex@localhost:5432/codex_clone";

export async function dockerUnavailable(): Promise<string | false> {
  const docker = new Docker({ socketPath: TEST_DOCKER_SOCKET });
  try {
    await docker.ping();
  } catch (err) {
    return `Docker is not reachable at ${TEST_DOCKER_SOCKET} (${(err as Error).message})`;
  }
  try {
    await docker.getImage(TEST_IMAGE).inspect();
  } catch {
    return `sandbox image "${TEST_IMAGE}" is not built; run \`pnpm agent:build\``;
  }
  return false;
}

/**
 * A TCP probe rather than a connection attempt through the driver: a driver
 * that cannot reach the server may also fail to shut down cleanly, which keeps
 * the Node process alive after the last test.
 */
export async function postgresUnavailable(url = TEST_DATABASE_URL, timeoutMs = 3_000): Promise<string | false> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `DATABASE_URL is not a URL: ${url}`;
  }
  const host = parsed.hostname || "localhost";
  const port = Number(parsed.port || 5432);

  const reason = await new Promise<string | false>((resolve) => {
    const socket = connect({ host, port });
    const done = (value: string | false) => {
      socket.destroy();
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done(`Postgres at ${host}:${port} did not accept a connection within ${timeoutMs}ms`), timeoutMs);
    socket.once("connect", () => done(false));
    socket.once("error", (err: Error) => done(`Postgres is not reachable at ${host}:${port} (${err.message})`));
  });

  return reason === false ? false : `${reason}; run \`pnpm db:up && pnpm db:migrate\``;
}

/** Fails loudly with context instead of waiting forever. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
