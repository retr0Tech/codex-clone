import { join } from "node:path";
import type Docker from "dockerode";
import type {
  AnyEventRow,
  BudgetBreach,
  DurableEventType,
  EventPayloadMap,
  ResourceLimits,
  RunBudget,
  RunStatus,
  SandboxHandle,
  SandboxProvider,
  SnapshotStore,
} from "@codex-clone/core";
import { BREACH_LABEL, DEFAULT_BUDGET, redact } from "@codex-clone/core";
import {
  appendEvent,
  highestSeqBefore,
  highestSeqForRun,
  toRow,
  type Database,
} from "@codex-clone/db";
import { recordMirror, type MirrorManager } from "@codex-clone/github";
import type { DockerSandboxSpec } from "@codex-clone/sandbox-docker";
import { workspaceVolumeName } from "@codex-clone/sandbox-docker";
import type { MeterRegistry, RunMeterSnapshot } from "../gateway/metering.js";
import { RunDeadline, wallClockReason } from "./deadline.js";
import {
  finalizeRun,
  loadTaskContext,
  recordVolume,
  setRunPhase,
  setRunSandbox,
  type TaskContext,
} from "./run-state.js";
import { restoreWorkspace } from "../snapshots/archive.js";
import { SeqAllocator, runBase } from "./seq.js";
import { DiffTrigger, deriveDiff } from "./diff.js";
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
  /**
   * The cold tier (PLAN.md §3.2). Optional: without one a reaped task simply
   * re-clones, which is wrong but not broken. With one, a task the reaper has
   * been through wakes back into the workspace it had.
   */
  snapshots?: SnapshotStore;
  meters: MeterRegistry;
  /** The PAT, for the mirror fetch. Resolved per run so a Settings change lands. */
  githubToken: () => Promise<string | null>;
  /** Model for this run, from the Settings row. */
  model: () => Promise<string>;
  /**
   * The run bounds (PLAN.md §3.4), resolved once per run so an edit in Settings
   * lands on the next run rather than on the next worker restart. The gateway
   * meter enforces turns and cost; the wall clock is enforced from here as
   * well, because the meter can only fire when the agent asks for a model call.
   */
  budget?: () => Promise<RunBudget>;
  /**
   * Where a repository is cloned from. Injectable so the integration test can
   * point at a bare repo on local disk instead of github.com -- the mirror
   * layer is the same either way, which is the point of having one.
   */
  cloneUrl?: (repo: { owner: string; name: string; fullName: string }) => string;
  config: {
    image: string;
    gatewaySocketPath: string;
    limits: ResourceLimits;
    stopGraceMs: number;
    dataDir: string;
    cacheVolumeName?: string | undefined;
  };
  /**
   * The WebSocket hub. Called ONLY for rows that were actually written -- a
   * replayed row is already in every subscriber's history, so re-broadcasting
   * it would put the same event on the wire twice.
   */
  publish?: (row: AnyEventRow) => void;
  /**
   * Tells the hub which task a run belongs to, before the first event exists.
   *
   * Token deltas carry only a runId, and they arrive per token -- a database
   * lookup per delta is not a design. Binding here also covers the adoption
   * path, where the run's opening events are replays and therefore never
   * published.
   */
  bindRun?: (runId: string, taskId: string) => void;
  releaseRun?: (runId: string) => void;
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
  /**
   * The bound this run actually hit, or null. Null for every run that was not
   * stopped by a budget -- including, emphatically, a cancelled one.
   */
  budgetBreach: BudgetBreach | null;
}

/**
 * The handle the cancel path holds: it can ask for a wind-down before the
 * container exists, and the supervisor will honour it as soon as it does.
 */
export class RunController {
  #cancelled: string | null = null;
  #timedOut: string | null = null;
  #handle: SandboxHandle | null = null;

  get cancelReason(): string | null {
    return this.#cancelled;
  }

  /** Set by the wall-clock deadline. Kept apart from `cancelReason` because a
   *  run that ran out of time and a run a person stopped are different facts. */
  get timeoutReason(): string | null {
    return this.#timedOut;
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

  markTimedOut(reason: string): void {
    this.#timedOut ??= reason;
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

  // Before anything else: deltas for this run must be routable from the first
  // token, and the first token can precede the first durable event.
  deps.bindRun?.(runId, taskId);

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
  const diffs = new DiffTrigger();

  const budget = await (deps.budget?.() ?? Promise.resolve(DEFAULT_BUDGET)).catch((error: unknown) => {
    // A budget nobody can read is a Settings problem, not a reason to refuse to
    // run; the built-in default still bounds the run, which is the point.
    log(`[run ${runId.slice(0, 8)}] could not read the run budget, using the default: ${redact(String(error))}`);
    return DEFAULT_BUDGET;
  });

  /**
   * The hard wall clock. The gateway meter checks the same bound, but only when
   * a model call arrives -- an agent wedged inside a tool call makes none, and
   * before this existed such a run held a concurrency slot indefinitely.
   *
   * Closing the meter first mirrors the cancel path exactly: no further model
   * call is admitted even mid-turn, and only then is the container SIGTERMed
   * with its grace period, so partial work still lands in the volume.
   */
  const deadline = RunDeadline.arm(budget.wallClockMs, () => {
    const reason = wallClockReason(budget.wallClockMs);
    controller.markTimedOut(reason);
    log(`[run ${runId.slice(0, 8)}] ${reason}`);
    deps.meters.peek(runId)?.close("wall_clock", reason);
    const live = controller.handle;
    if (live) {
      void deps.sandboxes
        .stop(live, { graceMs: deps.config.stopGraceMs, reason })
        .catch((err: unknown) => log(`[run ${runId.slice(0, 8)}] timeout stop failed: ${redact(String(err))}`));
    }
  });

  try {
    const task = await loadTaskContext(db, taskId);
    if (!task) throw new Error(`task ${taskId} disappeared between claim and start`);

    /**
     * Derives the diff and emits it into the gap after the last agent event.
     *
     * Failing to derive one must not fail the run: the agent's work is in the
     * volume either way, and a diff nobody could compute is a worse reason to
     * throw away a transcript than it is to log.
     */
    const emitDiff = async (): Promise<void> => {
      diffs.markDerived();
      const volumeName = task.volumeName ?? workspaceVolumeName(task.taskId);
      try {
        const payload = await deriveDiff({
          docker: deps.docker,
          volumeName,
          baseSha: task.baseSha,
          image: deps.config.image,
          dataDir: deps.config.dataDir,
          taskId: task.taskId,
        });
        await emit("diff", payload);
      } catch (error) {
        log(`[run ${runId.slice(0, 8)}] could not derive the diff: ${redact(String(error))}`);
      }
    };

    await emit("status", { status: "running" });

    if (handle) {
      log(`[run ${runId.slice(0, 8)}] re-attaching to sandbox ${handle.id.slice(0, 8)}`);
    } else {
      await emit("phase", { phase: "setup" });
      handle = await start(deps, task, { runId, prompt: claimed.prompt, budget }, emit, log);
      controller.attachHandle(handle);
      await setRunSandbox(db, runId, handle.id);
    }

    // The deadline can fire while the container is being created, exactly as a
    // cancel can. Both take the same path: stop it as soon as there is
    // something to stop.
    if (controller.timeoutReason && !controller.cancelReason) {
      await deps.sandboxes.stop(handle, {
        graceMs: deps.config.stopGraceMs,
        reason: controller.timeoutReason,
      });
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

      // A turn that changed the workspace has just ended: derive the diff BEFORE
      // ingesting this event, so it lands in the gap after the last tool result
      // rather than after the thing that opened the next turn. Ask mode never
      // writes, so it never pays for an extraction.
      if (task.mode === "code" && diffs.shouldDeriveBefore(event.type, event.payload)) {
        await emitDiff();
      }

      const row = { ...event, runId, taskId, seq: alloc.ingest(event.seq) } as AnyEventRow;
      if (await appendEvent(db, row)) deps.publish?.(row);

      if (row.type === "phase") await setRunPhase(db, runId, row.payload.phase);
      if (row.type === "status") {
        agentStatus = { status: row.payload.status, reason: row.payload.reason ?? null };
      }
    }

    // The stream can end mid-turn -- a cancel, a container that died, a budget
    // wind-down -- leaving work that no boundary event ever announced. Partial
    // work is still work, and it is still in the volume.
    if (task.mode === "code" && diffs.dirty) await emitDiff();
  } catch (error) {
    failure = redact(error instanceof Error ? error.message : String(error));
    log(`[run ${runId.slice(0, 8)}] failed: ${failure}`);
    await emit("error", { code: "run_failed", message: failure, retryable: false }).catch(() => undefined);
  } finally {
    // Every exit from the block above, including every throw. A live timer here
    // would hold a reference to a run that is already over.
    deadline.cancel();
  }

  return finalize(deps, { runId, taskId }, { handle, agentStatus, failure, controller, emit });
}

function defaultCloneUrl(repo: { fullName: string }): string {
  return `https://github.com/${repo.fullName}.git`;
}

/** Mirror, clone, seed, then create the container. */
async function start(
  deps: SupervisorDeps,
  task: TaskContext,
  run: { runId: string; prompt: string; budget: RunBudget },
  emit: Emitter,
  log: (message: string) => void,
): Promise<SandboxHandle> {
  const volumeName = task.volumeName ?? workspaceVolumeName(task.taskId);
  const workBranch = task.workBranch ?? workBranchName(task.title, task.taskId);

  const token = await deps.githubToken();
  const prepared = await prepareWorkspace(
    {
      taskId: task.taskId,
      volumeName,
      repo: {
        owner: task.repo.owner,
        name: task.repo.name,
        cloneUrl: (deps.cloneUrl ?? defaultCloneUrl)(task.repo),
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
      ...(deps.snapshots
        ? {
            restoreFromCold: async (ctx: { taskId: string; volumeName: string }) => {
              const meta = await restoreWorkspace({
                docker: deps.docker,
                store: deps.snapshots as SnapshotStore,
                taskId: ctx.taskId,
                volumeName: ctx.volumeName,
                image: deps.config.image,
                scratchRoot: join(deps.config.dataDir, "snapshot-staging"),
                onLog: (line) => {
                  log(`[task ${task.taskId.slice(0, 8)}] ${line.trimEnd()}`);
                  void emit("setup_log", { stream: "stdout", text: line });
                },
              });
              return meta !== null;
            },
          }
        : {}),
    },
    task.volumeName !== null,
  );
  await recordVolume(deps.db, task.taskId, volumeName, workBranch);

  // Records where the mirror is and when it was last fetched. That timestamp is
  // also the repo picker's "you were working here recently" signal -- without
  // this write every repo looks equally untouched and the picker opens on
  // whichever one sorts first alphabetically.
  await recordMirror(deps.db, task.repo.fullName, {
    mirrorPath: prepared.mirrorPath,
    mirrorFetchedAt: prepared.mirrorFetchedAt,
  }).catch((error: unknown) => {
    log(`[task ${task.taskId.slice(0, 8)}] could not record the mirror: ${redact(String(error))}`);
  });

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
    // One wall clock, not two: the container's limit and the host's deadline
    // are the same bound, so they are fed from the same number.
    limits: { ...deps.config.limits, wallClockMs: run.budget.wallClockMs },
    // Infrastructure only. `assertNoSecretsInEnv` refuses anything that looks
    // like a credential, and there is nothing here for it to refuse.
    env: {},
    job: {
      prompt: run.prompt,
      baseSha: task.baseSha,
      model: await deps.model(),
      /**
       * The runtime's own backstop, kept ONE turn above the gateway's ceiling.
       *
       * The gateway grants `maxTurns` forwards plus a final wind-down turn, so
       * a backstop set to `maxTurns` exactly would cut off the summary turn --
       * the most valuable one in a run that hit its budget. Deriving it from
       * the same number is what keeps a raised ceiling in Settings from being
       * silently capped by a constant compiled into the image.
       */
      maxTurns: run.budget.maxTurns + 1,
      ...(setupScript ? { setupScript } : {}),
    },
  };
  return deps.sandboxes.create(spec);
}

export interface FinalizeContext {
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
  const outcome = decideOutcome(ctx, usage);

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
    budgetBreach: outcome.budgetBreach,
    usage,
  });
  // Nothing further can be emitted for this run, so the delta route is dead.
  deps.releaseRun?.(ids.runId);

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

/**
 * How the run is recorded, in one place.
 *
 * The order is the priority order, and each step is a claim about who has the
 * better information:
 *
 *   1. cancel     the user asked for this; their reason beats everything
 *   2. timeout    the host stopped it; the agent's parting words cannot say why
 *   3. failure    the host saw the run throw
 *   4. the agent's own terminal status, refined by what the meter measured
 *
 * Steps 1 and 2 sit above 4 deliberately. Both stop the container, so whatever
 * the agent manages to emit on its way out -- typically `budget_exhausted`,
 * because the gateway refused its next call -- is a symptom of the stop rather
 * than an account of it. Reporting a cancelled run as a budget breach was a
 * real bug; `budgetBreach` is null on every path except a genuine one.
 */
export function decideOutcome(ctx: FinalizeContext, usage: RunMeterSnapshot | null): RunOutcome {
  if (ctx.controller.cancelReason) {
    return { status: "cancelled", stopReason: ctx.controller.cancelReason, budgetBreach: null };
  }
  if (ctx.controller.timeoutReason) {
    return { status: "timed_out", stopReason: ctx.controller.timeoutReason, budgetBreach: "wall_clock" };
  }
  if (ctx.failure) return { status: "failed", stopReason: ctx.failure, budgetBreach: null };

  if (ctx.agentStatus) {
    const reported = ctx.agentStatus.status;
    if (reported !== "budget_exhausted" && reported !== "timed_out") {
      return { status: reported, stopReason: ctx.agentStatus.reason, budgetBreach: null };
    }
    // The agent knows it was refused; the METER knows which bound did it. A
    // wall-clock breach reads as `timed_out`, so `budget_exhausted` always
    // means turns or cost -- two states, not one bucket.
    const breach = usage?.breach ?? (reported === "timed_out" ? "wall_clock" : null);
    const status: RunStatus = breach === "wall_clock" ? "timed_out" : "budget_exhausted";
    return { status, stopReason: budgetStopReason(breach, usage, ctx.agentStatus.reason), budgetBreach: breach };
  }

  // The stream ended without a terminal status: the container died without
  // saying anything. Never leave the run looking like it is still working.
  return {
    status: "failed",
    stopReason: "the sandbox exited without reporting a status",
    budgetBreach: null,
  };
}

/** Names the bound and what it cost to reach it, rather than only "exhausted". */
function budgetStopReason(
  breach: BudgetBreach | null,
  usage: RunMeterSnapshot | null,
  fallback: string | null,
): string | null {
  if (!breach) return fallback;
  const spent = usage
    ? ` after ${usage.turns} turn${usage.turns === 1 ? "" : "s"} and $${usage.costUsd.toFixed(4)}`
    : "";
  return `${BREACH_LABEL[breach]} was reached${spent}`;
}
