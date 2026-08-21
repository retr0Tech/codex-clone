import type { GatewayChunk, RunStatus, ToolName } from "@codex-clone/core";
import type { DurableEventWriter } from "./events.js";
import type { GatewayClient } from "./gateway-client.js";
import type { AgentJobSpec } from "./job-spec.js";
import type { ToolContext, ToolDef } from "./tools/index.js";
import { buildToolRegistry, toolSchemas } from "./tools/index.js";

/**
 * The agent loop.
 *
 * Shape is the OpenAI Responses API, but every request goes to the host
 * gateway over a unix socket. This process holds no API key, so the worst a
 * prompt injection can achieve here is wasting the run's budget -- which the
 * gateway is already metering.
 */

export interface AgentLoopResult {
  status: RunStatus;
  reason?: string;
  turns: number;
}

export interface AgentLoopDeps {
  job: AgentJobSpec;
  gateway: GatewayClient;
  writer: DurableEventWriter;
  /** Injectable so tests can drive the loop without a real filesystem. */
  registry?: Map<ToolName, ToolDef>;
  now?: () => number;
  signal?: AbortSignal;
}

type InputItem =
  | { role: "user" | "assistant" | "system"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

function systemPrompt(job: AgentJobSpec): string {
  const shared =
    `You are a coding agent working in ${job.workspacePath}, a git checkout pinned at ${job.baseSha}.\n` +
    `Investigate before you act, and prefer small, verifiable steps.\n` +
    `You have no network credentials and no access to GitHub: the host clones and pushes on your behalf.\n` +
    `When you are finished, reply with a short summary instead of calling another tool.`;

  // The prompt says the same thing the mount and the tool list already
  // enforce. It is here so the model does not waste turns discovering EROFS,
  // NOT as the mechanism -- the mechanism is structural.
  return job.mode === "ask"
    ? `${shared}\nThis is ASK mode: the workspace is mounted read-only and you have no patch tool. ` +
        `Answer questions and explain the code; do not attempt to modify anything.`
    : shared;
}

export async function runAgentLoop(deps: AgentLoopDeps): Promise<AgentLoopResult> {
  const { job, gateway, writer } = deps;
  const registry = deps.registry ?? buildToolRegistry(job.mode);
  const now = deps.now ?? Date.now;
  const toolCtx: ToolContext = {
    workspacePath: job.workspacePath,
    mode: job.mode,
    maxOutputBytes: job.maxToolOutputBytes,
  };

  const input: InputItem[] = [
    { role: "system", content: systemPrompt(job) },
    { role: "user", content: job.prompt },
  ];
  const tools = toolSchemas(registry);

  for (let turn = 0; turn < job.maxTurns; turn++) {
    if (deps.signal?.aborted) {
      return { status: "cancelled", reason: "cancelled by the host", turns: turn };
    }

    const collected = await collectTurn(gateway, {
      runId: job.runId,
      model: job.model,
      input,
      tools,
      stream: true,
    });

    // Order matters for readability of the transcript: reasoning, then the
    // assistant's words, then what it decided to do.
    if (collected.reasoning.trim() !== "") {
      writer.emit("reasoning", { text: collected.reasoning });
    }
    for (const [messageId, text] of collected.messages) {
      if (text.trim() === "") continue;
      // The coalesced message is the durable truth. The deltas that built it
      // were ephemeral overlay and were never written to this stream.
      writer.emit("message", { messageId, role: "assistant", text });
      input.push({ role: "assistant", content: text });
    }

    if (collected.refusal) {
      // Budget breach or upstream failure. The gateway has already granted the
      // wind-down turn; there is nothing further to negotiate, so we stop
      // rather than retry. Never hang, never spin.
      const { reason, message } = collected.refusal;
      writer.emit("error", {
        code: `gateway_refused:${reason}`,
        message,
        retryable: reason === "upstream_error",
      });
      return {
        status: reason === "upstream_error" ? "failed" : "budget_exhausted",
        reason: message,
        turns: turn + 1,
      };
    }

    if (collected.toolCalls.length === 0) {
      return { status: "succeeded", turns: turn + 1 };
    }

    for (const call of collected.toolCalls) {
      input.push({ type: "function_call", call_id: call.callId, name: call.name, arguments: call.args });
      const output = await dispatch(call, registry, toolCtx, writer, now);
      input.push({ type: "function_call_output", call_id: call.callId, output });
    }
  }

  // The gateway's maxTurns budget normally trips first; this is the runtime's
  // own backstop so a misconfigured budget cannot produce an unbounded loop.
  const message = `reached the runtime turn limit of ${job.maxTurns}`;
  writer.emit("error", { code: "turn_limit", message, retryable: false });
  return { status: "budget_exhausted", reason: message, turns: job.maxTurns };
}

interface CollectedTurn {
  reasoning: string;
  messages: Map<string, string>;
  toolCalls: Array<{ callId: string; name: string; args: string }>;
  refusal: { reason: string; message: string } | null;
}

async function collectTurn(
  gateway: GatewayClient,
  req: { runId: string; model: string; input: unknown; tools: unknown; stream: boolean },
): Promise<CollectedTurn> {
  const collected: CollectedTurn = { reasoning: "", messages: new Map(), toolCalls: [], refusal: null };

  for await (const chunk of gateway.send(req)) {
    switch ((chunk as GatewayChunk).type) {
      case "delta": {
        // EPHEMERAL. Accumulated here for the durable `message` at end of turn;
        // the live overlay is the gateway's job. Never written to stdout.
        const c = chunk as Extract<GatewayChunk, { type: "delta" }>;
        collected.messages.set(c.messageId, (collected.messages.get(c.messageId) ?? "") + c.text);
        break;
      }
      case "reasoning":
        collected.reasoning += (chunk as Extract<GatewayChunk, { type: "reasoning" }>).text;
        break;
      case "tool_call": {
        const c = chunk as Extract<GatewayChunk, { type: "tool_call" }>;
        collected.toolCalls.push({ callId: c.callId, name: c.name, args: c.args });
        break;
      }
      case "done":
        break;
      case "refused": {
        const c = chunk as Extract<GatewayChunk, { type: "refused" }>;
        collected.refusal = { reason: c.reason, message: c.message };
        // Stop reading immediately: a refusal ends the run either way, and
        // draining a stream that may never close is how a run hangs.
        return collected;
      }
    }
  }
  return collected;
}

async function dispatch(
  call: { callId: string; name: string; args: string },
  registry: Map<ToolName, ToolDef>,
  ctx: ToolContext,
  writer: DurableEventWriter,
  now: () => number,
): Promise<string> {
  const startedAt = now();
  const tool = registry.get(call.name as ToolName);

  let args: Record<string, unknown> = {};
  let parseError: string | null = null;
  try {
    const parsed: unknown = call.args === "" ? {} : JSON.parse(call.args);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      parseError = "tool arguments must be a JSON object";
    } else {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    parseError = "tool arguments were not valid JSON";
  }

  // The tool_call event is emitted even when the call is invalid, so the
  // transcript shows what the model actually asked for.
  const toolName = (tool?.name ?? call.name) as ToolName;
  writer.emit("tool_call", { callId: call.callId, tool: toolName, args });

  const fail = (message: string): string => {
    writer.emit("tool_result", {
      callId: call.callId,
      tool: toolName,
      ok: false,
      output: message,
      truncated: false,
      durationMs: now() - startedAt,
    });
    return message;
  };

  if (!tool) {
    // In ask mode this is how a model that hallucinates apply_patch is
    // answered: the tool simply does not exist here.
    return fail(`unknown tool "${call.name}"; available tools: ${[...registry.keys()].join(", ")}`);
  }
  if (parseError) return fail(parseError);

  try {
    const outcome = await tool.run(args, ctx);
    writer.emit("tool_result", {
      callId: call.callId,
      tool: toolName,
      ok: outcome.ok,
      output: outcome.output,
      truncated: outcome.truncated,
      ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
      durationMs: now() - startedAt,
    });
    return outcome.output;
  } catch (err) {
    return fail(`tool "${call.name}" threw: ${(err as Error).message}`);
  }
}
