import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A cross-process mutex for Docker-dependent test suites.
 *
 * `pnpm -r test` runs each package's suite concurrently, so the sandbox
 * integration tests and the agent/gateway end-to-end tests would otherwise
 * drive Docker Desktop at the same time. They interfere: Docker Desktop sets
 * up a forwarding channel per bind-mounted host unix socket, and under
 * concurrent container starts that work serialises inside the VM, leaving
 * containers stuck in `Created` well past any sensible timeout.
 *
 * Serialising the suites is the honest fix. The alternative -- raising the
 * timeouts until the flake usually passes -- produces a suite that fails for
 * unrelated reasons on a loaded machine, which is worse than a slow one.
 *
 * Deliberately dependency-free and self-healing: a lock whose owner died is
 * reclaimed after `staleMs`, so a killed test run cannot wedge the next one.
 */

const LOCK_PATH = join(tmpdir(), "codex-clone-docker-tests", "lock.json");

export interface DockerTestLock {
  release(): Promise<void>;
}

interface LockFile {
  pid: number;
  acquiredAt: number;
}

export interface AcquireOptions {
  /** Give up waiting after this long and proceed anyway. */
  timeoutMs?: number;
  /** Treat a lock older than this as abandoned. */
  staleMs?: number;
  pollMs?: number;
}

export async function acquireDockerTestLock(opts: AcquireOptions = {}): Promise<DockerTestLock> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const staleMs = opts.staleMs ?? 300_000;
  const pollMs = opts.pollMs ?? 150;

  await mkdir(join(tmpdir(), "codex-clone-docker-tests"), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      // wx fails if the file exists: that is the atomic part.
      await writeFile(LOCK_PATH, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() } satisfies LockFile), {
        flag: "wx",
      });
      return { release: () => rm(LOCK_PATH, { force: true }) };
    } catch {
      if (await reclaimIfStale(staleMs)) continue;
      if (Date.now() > deadline) {
        // Never fail a suite because of the lock itself.
        return { release: () => Promise.resolve() };
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

async function reclaimIfStale(staleMs: number): Promise<boolean> {
  try {
    const raw = await readFile(LOCK_PATH, "utf8");
    const lock = JSON.parse(raw) as LockFile;
    const expired = Date.now() - lock.acquiredAt > staleMs;
    const ownerGone = !isAlive(lock.pid);
    if (expired || ownerGone) {
      await rm(LOCK_PATH, { force: true });
      return true;
    }
  } catch {
    // Unreadable or half-written: treat as stale.
    await rm(LOCK_PATH, { force: true }).catch(() => undefined);
    return true;
  }
  return false;
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 checks existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
