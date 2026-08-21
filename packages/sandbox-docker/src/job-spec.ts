/**
 * The job spec moved to @codex-clone/core: it is provider-agnostic, and the
 * in-container runtime must not depend on the Docker implementation to learn
 * its own job shape. Re-exported here so this package remains a complete
 * description of what it writes into a container.
 */
export {
  type AgentJobSpec,
  DEFAULT_JOB_SPEC_PATH,
  DEFAULT_MAX_TOOL_OUTPUT_BYTES,
} from "@codex-clone/core";
