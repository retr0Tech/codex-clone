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

export const MANAGED_VALUE = "true";

export function managedFilter(kind?: string): Record<string, string[]> {
  const label = [`${LABEL_MANAGED}=${MANAGED_VALUE}`];
  if (kind) label.push(`${LABEL_KIND}=${kind}`);
  return { label };
}
