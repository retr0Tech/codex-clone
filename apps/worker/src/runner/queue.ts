import type { SandboxHandle } from "@codex-clone/core";
import { redact } from "@codex-clone/core";
import { claimNextRun, inFlightRuns } from "./claim.js";
import { RunController, abandonRun, superviseRun, type SupervisorDeps } from "./supervisor.js";

/**
 * The queue consumer (PLAN.md §3.9).
 *
 * At most `maxConcurrent` containers at once -- three on a laptop -- and the
 * surplus stays visibly `queued` in Postgres rather than being held in a
 * process-local list that dies with the worker. Claiming is
 * `FOR UPDATE SKIP LOCKED` (see claim.ts), so adding a second worker is a
 * deployment change and not a code change.
 *
 * Polling rather than LISTEN/NOTIFY: a one-second tick on a table with an index
 * built for exactly this query costs nothing measurable, and it has no
 * reconnect semantics to get wrong. The `EVENTS_CHANNEL` seam in @codex-clone/db
 * is where a push-based version would land if a worker pool ever needed it.
 */

export interface RunQueueOptions {
  deps: SupervisorDeps;
  workerId: string;
  maxConcurrent: number;
  pollMs?: number;
}

interface ActiveRun {
  taskId: string;
  controller: RunController;
  done: Promise<unknown>;
}

export const DEFAULT_POLL_MS = 1_000;

export class RunQueue {
  readonly #active = new Map<string, ActiveRun>();
  #timer: NodeJS.Timeout | null = null;
  #stopping = false;
  #ticking = false;

  constructor(private readonly options: RunQueueOptions) {}

  get activeCount(): number {
    return this.#active.size;
  }

  get activeRunIds(): string[] {
    return [...this.#active.keys()];
  }

  /**
   * Boot reconciliation (PLAN.md §7, risk 5).
   *
   * Docker is the authority on what is running, not our memory of it. Three
   * cases, and all three have to be handled or a restart leaks:
   *
   *   alive + run still `running`  -> re-adopt; attach replays the log from the
   *                                   start and the event log is idempotent, so
   *                                   the transcript picks up where it left off
   *   alive + no such run          -> orphan; destroy the container
   *   run `running` + not alive    -> the container died with the worker; mark
   *                                   the run failed with a visible reason
   */
  async reconcile(): Promise<void> {
    const { deps } = this.options;
    const log = deps.log ?? (() => undefined);

    const alive = await deps.sandboxes.list().catch((err: unknown) => {
      log(`[worker] could not reach Docker for reconciliation: ${redact(String(err))}`);
      return null;
    });
    if (alive === null) return;

    const bySandboxId = new Map<string, SandboxHandle>(alive.map((h) => [h.id, h]));
    const running = await inFlightRuns(deps.db);
    const adopted = new Set<string>();

    for (const run of running) {
      const handle = run.sandboxId ? bySandboxId.get(run.sandboxId) : undefined;
      if (handle) {
        adopted.add(handle.id);
        log(`[worker] adopting run ${run.runId.slice(0, 8)} on sandbox ${handle.id.slice(0, 8)}`);
        this.#spawn(run, { adopt: handle });
        continue;
      }
      log(`[worker] run ${run.runId.slice(0, 8)} has no live sandbox; marking it failed`);
      await abandonRun(deps, run, "the worker restarted and this run's sandbox was gone").catch((err: unknown) => {
        log(`[worker] could not finalize orphaned run ${run.runId.slice(0, 8)}: ${redact(String(err))}`);
      });
    }

    for (const handle of alive) {
      if (adopted.has(handle.id)) continue;
      log(`[worker] destroying orphaned sandbox ${handle.id.slice(0, 8)} (no run claims it)`);
      await deps.sandboxes.destroy(handle).catch(() => undefined);
    }
  }

  start(): void {
    if (this.#timer) return;
    this.#stopping = false;
    const tick = () => {
      void this.#tick().finally(() => {
        if (!this.#stopping) this.#timer = setTimeout(tick, this.options.pollMs ?? DEFAULT_POLL_MS);
      });
    };
    this.#timer = setTimeout(tick, 0);
  }

  /**
   * Stops claiming and waits for what is already running.
   *
   * Bounded: a container that will not wind down must not stop the worker from
   * exiting, or `pnpm dev` becomes unkillable.
   */
  async stop(graceMs = 15_000): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;

    const inFlight = [...this.#active.values()].map((a) => a.done);
    if (inFlight.length === 0) return;

    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(inFlight),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /**
   * Cancel from the UI (PLAN.md §3.4): close the meter first so no further
   * model call is admitted even if the container is mid-turn, then SIGTERM with
   * a grace period. Partial work survives regardless -- the volume is the state.
   */
  async cancel(runId: string, reason = "cancelled from the UI"): Promise<boolean> {
    const active = this.#active.get(runId);
    if (!active) return false;

    active.controller.markCancelled(reason);
    // Close the meter FIRST. A container mid-turn cannot be trusted to stop
    // itself, but it cannot make another model call once the gateway refuses --
    // so cancellation takes effect before the SIGTERM has even been sent.
    this.options.deps.meters
      .peek(runId)
      ?.close("wall_clock", `${reason}; the gateway will make no further model calls for this run`);

    const handle = active.controller.handle;
    if (handle) {
      await this.options.deps.sandboxes
        .stop(handle, { graceMs: this.options.deps.config.stopGraceMs, reason })
        .catch((err: unknown) => {
          this.options.deps.log?.(`[run ${runId.slice(0, 8)}] stop failed: ${redact(String(err))}`);
        });
    }
    return true;
  }

  async #tick(): Promise<void> {
    if (this.#ticking || this.#stopping) return;
    this.#ticking = true;
    try {
      while (this.#active.size < this.options.maxConcurrent && !this.#stopping) {
        const claimed = await claimNextRun(this.options.deps.db, this.options.workerId);
        if (!claimed) return;
        this.options.deps.log?.(
          `[worker] claimed run ${claimed.runId.slice(0, 8)} for task ${claimed.taskId.slice(0, 8)}`,
        );
        this.#spawn(claimed);
      }
    } catch (err) {
      this.options.deps.log?.(`[worker] claim failed: ${redact(String(err))}`);
    } finally {
      this.#ticking = false;
    }
  }

  #spawn(claimed: { runId: string; taskId: string; prompt: string }, options: { adopt?: SandboxHandle } = {}): void {
    const controller = new RunController();
    if (options.adopt) controller.attachHandle(options.adopt);

    const done = superviseRun(this.options.deps, claimed, controller, options)
      .then((outcome) => {
        this.options.deps.log?.(
          `[worker] run ${claimed.runId.slice(0, 8)} ended ${outcome.status}` +
            `${outcome.stopReason ? ` (${outcome.stopReason})` : ""}`,
        );
      })
      .catch((err: unknown) => {
        // superviseRun finalises its own failures; reaching here means the
        // finalisation itself failed, which must not take the worker down.
        this.options.deps.log?.(`[worker] run ${claimed.runId.slice(0, 8)} crashed: ${redact(String(err))}`);
      })
      .finally(() => {
        this.#active.delete(claimed.runId);
      });

    this.#active.set(claimed.runId, { taskId: claimed.taskId, controller, done });
  }
}
