import type Docker from "dockerode";
import { LABEL_KIND, LABEL_MANAGED, LABEL_TASK_ID, MANAGED_VALUE, managedFilter } from "./labels.js";

/**
 * The hot tier of the two-tier workspace store (PLAN.md section 3.2).
 *
 * A workspace volume outlives its container by design: `destroy()` removes the
 * container and leaves the volume, which is what makes "durable after every
 * turn" free rather than a per-turn export. Removal is therefore a separate,
 * deliberate call made by the idle reaper AFTER a cold snapshot exists.
 */

export const VOLUME_KIND_WORKSPACE = "workspace";
export const VOLUME_KIND_CACHE = "cache";

export function workspaceVolumeName(taskId: string): string {
  return `ws-${taskId}`;
}

export async function ensureVolume(
  docker: Docker,
  name: string,
  opts: { kind: string; taskId?: string } = { kind: VOLUME_KIND_WORKSPACE },
): Promise<void> {
  const labels: Record<string, string> = {
    [LABEL_MANAGED]: MANAGED_VALUE,
    [LABEL_KIND]: opts.kind,
  };
  if (opts.taskId) labels[LABEL_TASK_ID] = opts.taskId;
  // createVolume is idempotent for an existing name; it returns the existing
  // volume rather than erroring, so this doubles as "ensure".
  await docker.createVolume({ Name: name, Labels: labels });
}

export async function volumeExists(docker: Docker, name: string): Promise<boolean> {
  try {
    await docker.getVolume(name).inspect();
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/** Destroys workspace state. Only the reaper should call this, post-snapshot. */
export async function removeVolume(docker: Docker, name: string, opts: { force?: boolean } = {}): Promise<void> {
  try {
    await docker.getVolume(name).remove({ force: opts.force ?? false });
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
}

export async function listManagedVolumes(docker: Docker, kind?: string): Promise<string[]> {
  const res = (await docker.listVolumes({ filters: managedFilter(kind) })) as {
    Volumes?: Array<{ Name: string }> | null;
  };
  return (res.Volumes ?? []).map((v) => v.Name);
}

export function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { statusCode?: number }).statusCode === 404;
}
