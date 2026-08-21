import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type Docker from "dockerode";
import { AGENT_UID, AGENT_GID, LABEL_KIND, LABEL_MANAGED, LABEL_TASK_ID, MANAGED_VALUE } from "@codex-clone/sandbox-docker";

const execFileAsync = promisify(execFile);

/**
 * Moving a directory tree between the host and a Docker named volume.
 *
 * The host cannot address a named volume directly -- on Docker Desktop it lives
 * inside the VM -- but every git operation in this system runs on the host
 * (PLAN.md §3.3). So the two have to meet somewhere, and the meeting point is
 * the archive endpoint: a container is CREATED with the volume mounted and
 * never started, the tree is streamed in or out through
 * `PUT/GET /containers/{id}/archive`, and the container is removed. Nothing
 * executes; the daemon does the extraction.
 *
 * Ownership is the subtle part. The agent runs as uid 10001 and the rootfs is
 * read-only, so a workspace it cannot write is a run that fails on its first
 * `apply_patch`. Docker applies the uid/gid recorded in the tar headers, so the
 * archive is built with 10001 baked in and no chown step -- and therefore no
 * root-capable container -- is needed anywhere.
 */

export const HELPER_KIND = "volume-io";

/** The mount point inside every sandbox, and therefore inside every helper. */
export const WORKSPACE_PATH = "/workspace";

/** Bounded, because a stalled daemon must not hold a concurrency slot forever. */
export const DEFAULT_ARCHIVE_TIMEOUT_MS = 10 * 60 * 1000;

export class VolumeIoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VolumeIoError";
  }
}

interface HelperOptions {
  image: string;
  taskId?: string;
  timeoutMs?: number;
}

/**
 * Creates a stopped container with the volume mounted, hands it to `fn`, and
 * removes it afterwards -- including when `fn` throws, so a failure cannot
 * strand a container holding a lock on the volume.
 */
async function withMountedVolume<T>(
  docker: Docker,
  volumeName: string,
  opts: HelperOptions,
  fn: (container: Docker.Container) => Promise<T>,
): Promise<T> {
  const labels: Record<string, string> = {
    [LABEL_MANAGED]: MANAGED_VALUE,
    [LABEL_KIND]: HELPER_KIND,
  };
  if (opts.taskId) labels[LABEL_TASK_ID] = opts.taskId;

  const container = await docker.createContainer({
    Image: opts.image,
    // Never started. The command is required by the API shape, not by us.
    Entrypoint: [],
    Cmd: ["true"],
    Labels: labels,
    HostConfig: {
      Mounts: [{ Type: "volume", Source: volumeName, Target: WORKSPACE_PATH, ReadOnly: false }],
      // No network and no capabilities: this container never runs, and if a
      // future change ever starts it, it should still be able to do nothing.
      NetworkMode: "none",
      CapDrop: ["ALL"],
      AutoRemove: false,
    },
  });

  try {
    return await fn(container);
  } finally {
    await container.remove({ force: true, v: false }).catch(() => undefined);
  }
}

/**
 * Streams a host directory into the volume at /workspace.
 *
 * The tar is built with uid/gid 10001 so the extracted tree is writable by the
 * agent without any chown.
 */
export async function uploadDirectory(
  docker: Docker,
  volumeName: string,
  sourceDir: string,
  opts: HelperOptions,
): Promise<void> {
  const flags = await ownershipFlags();

  await withMountedVolume(docker, volumeName, opts, async (container) => {
    const tar = spawn("tar", ["-C", sourceDir, ...flags, "--numeric-owner", "-cf", "-", "."], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    tar.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const exited = new Promise<void>((resolve, reject) => {
      tar.once("error", reject);
      tar.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new VolumeIoError(`tar exited ${code} while packing ${sourceDir}: ${stderr.trim()}`));
      });
    });

    try {
      await withTimeout(
        Promise.all([container.putArchive(tar.stdout, { path: WORKSPACE_PATH }), exited]),
        opts.timeoutMs ?? DEFAULT_ARCHIVE_TIMEOUT_MS,
        `uploading ${sourceDir} into volume ${volumeName}`,
      );
    } catch (err) {
      // A putArchive that rejected leaves tar writing into a closed pipe; kill
      // it rather than leaving a process attached to a dead socket.
      tar.kill("SIGKILL");
      throw err;
    }
  });
}

/**
 * Streams /workspace out of the volume into a fresh host directory.
 *
 * Used for every host-side git operation on a live workspace: deriving the diff
 * and pushing the branch. A fresh directory each time rather than an
 * incremental sync, because tar extraction adds and overwrites but never
 * deletes -- and a file the agent removed has to show up in the diff as
 * removed.
 */
export async function downloadWorkspace(
  docker: Docker,
  volumeName: string,
  targetDir: string,
  opts: HelperOptions,
): Promise<void> {
  await mkdir(targetDir, { recursive: true });

  await withMountedVolume(docker, volumeName, opts, async (container) => {
    const stream = await container.getArchive({ path: `${WORKSPACE_PATH}/.` });
    const tar = spawn("tar", ["-C", targetDir, "-xf", "-"], { stdio: ["pipe", "ignore", "pipe"] });

    let stderr = "";
    tar.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const exited = new Promise<void>((resolve, reject) => {
      tar.once("error", reject);
      tar.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new VolumeIoError(`tar exited ${code} while unpacking into ${targetDir}: ${stderr.trim()}`));
      });
    });

    stream.pipe(tar.stdin);
    await withTimeout(exited, opts.timeoutMs ?? DEFAULT_ARCHIVE_TIMEOUT_MS, `downloading volume ${volumeName}`);
  });
}

/**
 * Extracts the workspace to a temp directory, runs `fn` against it, and removes
 * it -- so host-side git sees the live tree without the volume ever being
 * mounted into something that executes code.
 */
export async function withWorkspaceCopy<T>(
  docker: Docker,
  volumeName: string,
  scratchRoot: string,
  opts: HelperOptions,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  await mkdir(scratchRoot, { recursive: true });
  const dir = await mkdtemp(join(scratchRoot, "ws-"));
  try {
    await downloadWorkspace(docker, volumeName, dir, opts);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * `tar` flags that stamp uid/gid 10001 onto every entry.
 *
 * macOS ships bsdtar and Linux ships GNU tar, and they spell this differently.
 * Detected once rather than assumed, because getting it wrong produces a
 * workspace owned by root that the agent silently cannot write.
 */
let cachedFlags: string[] | null = null;

export async function ownershipFlags(): Promise<string[]> {
  if (cachedFlags) return cachedFlags;
  let version = "";
  try {
    version = (await execFileAsync("tar", ["--version"], { timeout: 10_000 })).stdout;
  } catch {
    // Fall through to the GNU spelling; the failure will surface from the pack.
  }
  cachedFlags = /bsdtar|libarchive/i.test(version)
    ? ["--uid", String(AGENT_UID), "--gid", String(AGENT_GID)]
    : [`--owner=${AGENT_UID}`, `--group=${AGENT_GID}`];
  return cachedFlags;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new VolumeIoError(`${what} did not finish within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
