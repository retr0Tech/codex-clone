import { join } from "node:path";
import type Docker from "dockerode";
import type {
  AnyEventRow,
  DurableEventType,
  EventPayloadMap,
  ResourceLimits,
  RunStatus,
  SandboxHandle,
  SandboxProvider,
} from "@codex-clone/core";
import { redact } from "@codex-clone/core";
import type { Database } from "@codex-clone/db";
import type { MirrorManager } from "@codex-clone/github";
import type { DockerSandboxSpec } from "@codex-clone/sandbox-docker";
import { workspaceVolumeName } from "@codex-clone/sandbox-docker";
import type { MeterRegistry } from "../gateway/metering.js";
import { appendEvent, highestSeqBefore, highestSeqForRun, toRow } from "./event-log.js";
import {
  finalizeRun,
  loadTaskContext,
  recordVolume,
  setRunPhase,
  setRunSandbox,
  type TaskContext,
} from "./run-state.js";
import { SeqAllocator, runBase } from "./seq.js";
import { prepareWorkspace, workBranchName } from "./workspace.js";

/**
 * One run, from claim to terminal status.
 *
 * The order below is not incidental:
 *
 *   host events ──▶ workspace seeded ──▶ container created ──▶ attach
 *        │                                                       │
 *        └────────────── one event log, one seq space ───────────┘
 *
 * The host writes the transcript's first line before any container exists, so a
 * run that dies during `git clone` reads as a failed setup rather than as a
 * task that never started. Everything the container says is renumbered on
 * ingest into that same space (see `seq.ts`), which is what lets the host slot
 * its own derived events -- the diff, the terminal status -- into the stream.
 *
 * Every exit from this function, including every throw, ends in `finalize()`:
 * meter released, container destroyed, volume kept, run marked terminal. A run
 * that ends any other way holds one of three concurrency slots forever.
 */

export type Emitter = <T extends DurableEventType>(type: T, payload: EventPayloadMap[T]) => Promise<void>;

export interface SupervisorDeps {
  db: Database;
  docker: Docker;
  sandboxes: SandboxProvider;
  mirrors: MirrorManager;
  meters: MeterRegistry;
  /** The PAT, for the mirror fetch. Resolved per run so a Settings change lands. */
  githubToken: () => Promise<string | null>;
  /** Model for this run, from the Settings row. */
  model: () => Promise<string>;
  config: {
    image: string;
    gatewaySocketPath: string;
    limits: ResourceLimits;
    stopGraceMs: number;
    dataDir: string;
    cacheVolumeName?: string | undefined;
  };
  /** The WebSocket hub subscribes here in milestone 6. */
  publish?: (row: AnyEventRow) => void;
  log?: (message: string) => void;
}

export interface SuperviseOptions {
  /**
   * An existing container to re-attach to instead of creating one. Set only by
   * boot reconciliation, when a restart found a sandbox still running for a run
   * the database still calls `running`.
   */
  adopt?: SandboxHandle;
}

export interface RunOutcome {
  status: RunStatus;
  stopReason: string | null;
}

/**
 * The handle the cancel path holds: it can ask for a wind-down before the
 * container exists, and the supervisor will honour it as soon as it does.
 */
export class RunController {
  #cancelled: string | null = null;
  #handle: SandboxHandle | null = null;

  get cancelReason(): string | null {
    return this.#cancelled;
  }

  get handle(): SandboxHandle | null {
    return this.#handle;
  }

  attachHandle(handle: SandboxHandle): void {
    this.#handle = handle;
  }

  markCancelled(reason: string): void {
    this.#cancelled ??= reason;
  }
}

export async function superviseRun(
  deps: SupervisorDeps,
  claimed: { runId: string; taskId: string; prompt: string },
  controller: RunController = new RunController(),
  options: SuperviseOptions = {},
): Promise<RunOutcome> {
  const { db } = deps;
  const { runId, taskId } = claimed;
  const log = deps.log ?? (() => undefined);

  // Base the run above every seq this task has already used, EXCLUDING this
  // run's own rows -- so a restart mid-run recomputes the identical base and
  // the replayed events collide with the ones already stored.
  const alloc = new SeqAllocator(runBase(await highestSeqBefore(db, taskId, runId)));

  const emit: Emitter = async (type, payload) => {
    const row = toRow({ runId, taskId, seq: alloc.host(), type, payload });
    if (await appendEvent(db, row)) deps.publish?.(row);
  };

  let handle: SandboxHandle | null = options.adopt ?? null;
  let agentStatus: { status: RunStatus; reason: string | null } | null = null;
  let failure: string | null = null;

  try {
    const task = await loadTaskContext(db, taskId);
    if (!task) throw new Error(`task ${taskId} disappeared between claim and start`);

    await emit("status", { status: "running" });

    if (handle) {
      log(`[run ${runId.slice(0, 8)}] re-attaching to sandbox ${handle.id.slice(0, 8)}`);
    } else {
      await emit("phase", { phase: "setup" });
      handle = await start(deps, task, { runId, prompt: claimed.prompt }, emit, log);
      controller.attachHandle(handle);
      await setRunSandbox(db, runId, handle.id);
    }

    // Cancel may have arrived while the container was being created. Take the
    // wind-down path immediately rather than letting a doomed run start work.
    if (controller.cancelReason) {
      await deps.sandboxes.stop(handle, { graceMs: deps.config.stopGraceMs, reason: controller.cancelReason });
    }

    for await (const event of deps.sandboxes.attach(handle)) {
      // A stream fault arrives as a yielded event with seq -1 rather than as a
      // rejection (PLAN.md §7 risk 4: a visible event, never a hang). It has no
      // place in the agent's numbering, so it gets a host address.
      if (event.seq < 0) {
        await emit(event.type, event.payload as EventPayloadMap[DurableEventType]);
        continue;
      }

      const row = { ...event, runId, taskId, seq: alloc.ingest(event.seq) } as AnyEventRow;
      if (await appendEvent(db, row)) deps.publish?.(row);

      if (row.type === "phase") await setRunPhase(db, runId, row.payload.phase);
      if (row.type === "status") {
        agentStatus = { status: row.payload.status, reason: row.payload.reason ?? null };
      }
    }
  } catch (error) {
    failure = redact(error instanceof Error ? error.message : String(error));
    log(`[run ${runId.slice(0, 8)}] failed: ${failure}`);
    await emit("error", { code: "run_failed", message: failure, retryable: false }).catch(() => undefined);
  }

  return finalize(deps, { runId, taskId }, { handle, agentStatus, failure, controller, emit });
}

/** Mirror, clone, seed, then create the container. */
async function start(
  deps: SupervisorDeps,
  task: TaskContext,
  run: { runId: string; prompt: string },
  emit: Emitter,
  log: (message: string) => void,
): Promise<SandboxHandle> {
  const volumeName = task.volumeName ?? workspaceVolumeName(task.taskId);
  const workBranch = task.workBranch ?? workBranchName(task.title, task.taskId);

  const token = await deps.githubToken();
  await prepareWorkspace(
    {
      taskId: task.taskId,
      volumeName,
      repo: {
        owner: task.repo.owner,
        name: task.repo.name,
        cloneUrl: `https://github.com/${task.repo.fullName}.git`,
      },
      baseSha: task.baseSha,
      workBranch,
      ...(token === null ? {} : { token }),
    },
    {
      docker: deps.docker,
      mirrors: deps.mirrors,
      image: deps.config.image,
      scratchRoot: join(deps.config.dataDir, "staging"),
      // Host-side progress is transcript, not diagnostics: a slow clone should
      // be visible in the UI rather than only in the worker's console.
      onLog: (line) => {
        log(`[task ${task.taskId.slice(0, 8)}] ${line.trimEnd()}`);
        void emit("setup_log", { stream: "stdout", text: line });
      },
    },
    task.volumeName !== null,
  );
  await recordVolume(deps.db, task.taskId, volumeName, workBranch);

  const setupScript = task.repo.setupScript ?? undefined;
  const spec: DockerSandboxSpec = {
    taskId: task.taskId,
    runId: run.runId,
    image: deps.config.image,
    mode: task.mode,
    volumeName,
    gatewaySocketPath: deps.config.gatewaySocketPath,
    ...(deps.config.cacheVolumeName ? { cacheVolumeName: deps.config.cacheVolumeName } : {}),
    ...(setupScript ? { setupScript } : {}),
    limits: deps.config.limits,
    // Infrastructure only. `assertNoSecretsInEnv` refuses anything that looks
    // like a credential, and there is nothing here for it to refuse.
    env: {},
    job: {
      prompt: run.prompt,
      baseSha: task.baseSha,
      model: await deps.model(),
      ...(setupScript ? { setupScript } : {}),
    },
  };
  return deps.sandboxes.create(spec);
}

interface FinalizeContext {
  handle: SandboxHandle | null;
  agentStatus: { status: RunStatus; reason: string | null } | null;
  failure: string | null;
  controller: RunController;
  emit: Emitter;
}

/**
 * Release the meter, drop the container, keep the volume.
 *
 * `destroy()` deliberately does not remove the workspace volume: the volume IS
 * the state a follow-up turn resumes from (PLAN.md §3.1). Removing it belongs
 * to the idle reaper, after a cold snapshot exists.
 */
async function finalize(
  deps: SupervisorDeps,
  ids: { runId: string; taskId: string },
  ctx: FinalizeContext,
): Promise<RunOutcome> {
  const usage = deps.meters.release(ids.runId);
  const outcome = decideOutcome(ctx);

  // The agent's own terminal status is already in the log; anything else is the
  // host's word and has to be written as such, so the transcript never ends
  // without saying how -- and so `stop_reason`, which the provider does not
  // record, is recorded here.
  if (!ctx.agentStatus || outcome.status !== ctx.agentStatus.status) {
    await ctx
      .emit(
        "status",
        outcome.stopReason === null
          ? { status: outcome.status }
          : { status: outcome.status, reason: outcome.stopReason },
      )
      .catch(() => undefined);
  }

  if (ctx.handle) {
    await deps.sandboxes.destroy(ctx.handle).catch((err: unknown) => {
      deps.log?.(`[run ${ids.runId.slice(0, 8)}] destroy failed: ${redact(String(err))}`);
    });
  }

  await finalizeRun(deps.db, ids.runId, ids.taskId, {
    status: outcome.status,
    stopReason: outcome.stopReason,
    usage,
  });

  return outcome;
}

/**
 * Closes out a run whose sandbox is gone.
 *
 * Boot reconciliation calls this for anything the database still calls
 * `running` but Docker has never heard of. The alternative -- leaving the row
 * alone -- produces a task that shows a spinner forever, which is the failure
 * mode PLAN.md §3.9 explicitly rules out.
 */
export async function abandonRun(
  deps: Pick<SupervisorDeps, "db" | "meters" | "publish">,
  ids: { runId: string; taskId: string },
  reason: string,
): Promise<void> {
  // Straight after whatever this run last managed to say -- not at its base,
  // which is already occupied by the `running` status it opened with.
  const [before, own] = await Promise.all([
    highestSeqBefore(deps.db, ids.taskId, ids.runId),
    highestSeqForRun(deps.db, ids.runId),
  ]);
  const row = toRow({
    runId: ids.runId,
    taskId: ids.taskId,
    seq: Math.max(runBase(before), own) + 1,
    type: "status",
    payload: { status: "failed", reason },
  });
  if (await appendEvent(deps.db, row)) deps.publish?.(row);

  deps.meters.release(ids.runId);
  await finalizeRun(deps.db, ids.runId, ids.taskId, { status: "failed", stopReason: reason });
}

function decideOutcome(ctx: FinalizeContext): RunOutcome {
  // Cancel wins over whatever the agent managed to say on its way out: the user
  // asked for this, and the reason they get should be theirs.
  if (ctx.controller.cancelReason) {
    return { status: "cancelled", stopReason: ctx.controller.cancelReason };
  }
  if (ctx.failure) return { status: "failed", stopReason: ctx.failure };
  if (ctx.agentStatus) return { status: ctx.agentStatus.status, stopReason: ctx.agentStatus.reason };
  // The stream ended without a terminal status: the container died without
  // saying anything. Never leave the run looking like it is still working.
  return { status: "failed", stopReason: "the sandbox exited without reporting a status" };
}
