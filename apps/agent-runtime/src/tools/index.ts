import type { SandboxMode, ToolName } from "@codex-clone/core";
import type { ToolDef, ToolSchema } from "./types.js";
import { applyPatchTool } from "./apply-patch.js";
import { grepTool } from "./grep.js";
import { readFileTool } from "./read-file.js";
import { shellTool } from "./shell.js";

export * from "./types.js";
export { applyPatchTool } from "./apply-patch.js";
export { grepTool } from "./grep.js";
export { readFileTool, resolveInWorkspace } from "./read-file.js";
export { shellTool } from "./shell.js";
export * from "./patch-format.js";

const READ_ONLY_TOOLS: ToolDef[] = [shellTool, readFileTool, grepTool];

/**
 * ASK MODE IS STRUCTURAL (PLAN.md section 3.8).
 *
 * In ask mode apply_patch is not "discouraged" or "removed from the prompt" --
 * it is not in the tool list the model is given, so there is no call it can
 * emit that this process will dispatch. Independently, the host mounts
 * /workspace read-only, so even a `shell` call that tries to write gets EROFS
 * from the kernel. Two layers, neither of them a sentence in a prompt.
 */
export function buildToolRegistry(mode: SandboxMode): Map<ToolName, ToolDef> {
  const tools = mode === "ask" ? READ_ONLY_TOOLS : [...READ_ONLY_TOOLS, applyPatchTool];
  return new Map(tools.map((t) => [t.name, t]));
}

export function toolSchemas(registry: Map<ToolName, ToolDef>): ToolSchema[] {
  return [...registry.values()].map((t) => t.schema);
}
