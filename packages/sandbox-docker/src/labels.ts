/**
 * Every object this provider creates is labelled, so `list()` can reconcile
 * worker state against Docker after a restart (PLAN.md section 7, risk 5)
 * without keeping a process-local registry that dies with the worker.
 */
export const LABEL_MANAGED = "com.codex-clone.managed";
export const LABEL_SANDBOX_ID = "com.codex-clone.sandbox-id";
export const LABEL_TASK_ID = "com.codex-clone.task-id";
export const LABEL_RUN_ID = "com.codex-clone.run-id";
export const LABEL_MODE = "com.codex-clone.mode";
export const LABEL_KIND = "com.codex-clone.kind";

/**
 * Which checkout owns this object.
 *
 * Reconciliation destroys every managed sandbox no live run claims, and "no
 * live run claims it" is answered from the worker's OWN database. Two workers
 * against one Docker daemon -- which is what running two Conductor workspaces
 * at once means -- would therefore have each one tear down the other's
 * containers on boot, because a sibling's run is not in this worker's runs
 * table. Scoping the filter by workspace is what makes the two workers blind
 * to each other.
 *
 * `default` outside Conductor, so a single-workspace checkout is unaffected.
 */
export const LABEL_WORKSPACE = "com.codex-clone.workspace";

export const MANAGED_VALUE = "true";
export const DEFAULT_WORKSPACE_ID = "default";

export function managedFilter(kind?: string, workspaceId?: string): Record<string, string[]> {
  const label = [`${LABEL_MANAGED}=${MANAGED_VALUE}`];
  if (kind) label.push(`${LABEL_KIND}=${kind}`);
  if (workspaceId) label.push(`${LABEL_WORKSPACE}=${workspaceId}`);
  return { label };
}
