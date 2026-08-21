import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import Docker from "dockerode";
import { eq } from "drizzle-orm";
import { DEFAULT_LIMITS } from "@codex-clone/core";
import {
  createDb,
  readEvents,
  repos,
  runs,
  scheduledExecutions,
  scheduledJobs,
  tasks,
  type Database,
} from "@codex-clone/db";
import { MirrorManager } from "@codex-clone/github";
import {
  acquireDockerTestLock,
  DockerSandbox,
  removeVolume,
  workspaceVolumeName,
  type DockerTestLock,
} from "@codex-clone/sandbox-docker";
import { StaticCredentialStore } from "../gateway/credentials.js";
import { FakeUpstream, upstream } from "../gateway/fake-upstream.js";
import { GatewayServer } from "../gateway/server.js";
import { claimNextRun } from "../runner/claim.js";
import { git } from "../runner/git.js";
import { publishTask } from "../runner/publish.js";
import { superviseRun, type SupervisorDeps } from "../runner/supervisor.js";
import { FsSnapshotStore } from "../snapshots/index.js";
import {
  TEST_DATABASE_URL,
  TEST_DOCKER_SOCKET,
  TEST_IMAGE,
  dockerUnavailable,
  postgresUnavailable,
  withTimeout,
} from "../runner/testing.js";
import { Scheduler } from "./scheduler.js";
import type { SchedulerDeps } from "./types.js";

/**
 * Milestone 9 end to end, with everything real except the model.
 *
 *   scheduled_jobs(next_run_at in the past)
 *        │ tick: claim ─▶ execution ─▶ fresh task + queued run
 *        ▼
 *   the milestone 5 run loop: mirror ─▶ NEW volume ─▶ real container
 *        │
 *        ▼
 *   tick: settle ─▶ the milestone 7 publish path ─▶ scheduled/<job>/<ts>
 *                                                   on a bare repo on disk
 *
 * The point of the test is that nothing in the middle of that diagram is new
 * code. A scheduled execution is an ordinary task with an ordinary queued run,
 * so what is being checked is that the scheduler hands the existing machinery
 * something it can execute and gets something publishable back.
 *
 * The model is `FakeUpstream` and the origin is a bare repository on local
 * disk, so this reaches neither api.openai.com nor github.com. Skips cleanly,
 * with a reason, when Docker or Postgres is absent; every wait is bounded.
 */

const TEST_TIMEOUT_MS = 240_000;
const FAKE_KEY = "sk-test-not-a-real-key-000000000000";

const skip = (await dockerUnavailable()) || (await postgresUnavailable());

describe(
  "a scheduled job, fired and pushed for real",
  { skip: skip === false ? undefined : skip },
  () => {
    let docker: Docker;
    let db: Database;
    let closeDb: () => Promise<unknown>;
    let sandbox: DockerSandbox;
    let hostDir: string;
    let dataDir: string;
    let originPath: string;
    let lock: DockerTestLock;
    let gateway: GatewayServer | null = null;

    const repoIds: string[] = [];
    const jobIds: string[] = [];
    const taskIds: string[] = [];
    const volumes = new Set<string>();

    before(async () => {
      // Two suites driving Docker Desktop at once wedge its socket forwarder.
      lock = await acquireDockerTestLock();
      docker = new Docker({ socketPath: TEST_DOCKER_SOCKET });
      ({ db, close: closeDb } = createDb(TEST_DATABASE_URL));
      await withTimeout(db.execute("select 1"), 10_000, "connecting to Postgres");

      // Under $HOME: Docker Desktop's file-sharing allowlist covers /Users but
      // not /private/var/folders, and the gateway socket has to be bind-mounted.
      hostDir = await realpath(await mkdtemp(join(homedir(), ".codexclone-m9-")));
      dataDir = join(hostDir, "data");
      await mkdir(join(hostDir, "gw"), { recursive: true, mode: 0o700 });
      await mkdir(join(dataDir, "jobs"), { recursive: true, mode: 0o700 });
      sandbox = new DockerSandbox({ socketPath: TEST_DOCKER_SOCKET, jobSpecDir: join(dataDir, "jobs") });
      originPath = await createOriginRepo(join(hostDir, "origin"));
    });

    after(async () => {
      await gateway?.close().catch(() => undefined);
      for (const volume of volumes) await removeVolume(docker, volume, { force: true }).catch(() => undefined);
      if (db) {
        for (const taskId of taskIds) {
          await db.delete(tasks).where(eq(tasks.id, taskId)).catch(() => undefined);
        }
        for (const jobId of jobIds) {
          await db.delete(scheduledJobs).where(eq(scheduledJobs.id, jobId)).catch(() => undefined);
        }
        for (const repoId of repoIds) await db.delete(repos).where(eq(repos.id, repoId)).catch(() => undefined);
      }
      await closeDb?.().catch(() => undefined);
      if (hostDir) await rm(hostDir, { recursive: true, force: true }).catch(() => undefined);
      await lock?.release().catch(() => undefined);
    });

    /** A real git repository on local disk, standing in for github.com. */
    async function createOriginRepo(root: string): Promise<string> {
      const bare = join(root, "origin.git");
      const work = join(root, "work");
      await mkdir(work, { recursive: true });
      await git(["init", "--bare", "--initial-branch=main", bare]);
      await git(["init", "--initial-branch=main", work]);
      await writeFile(join(work, "README.md"), "# fixture\n\nA repository a schedule will edit.\n");
      await git(["add", "-A"], { cwd: work });
      await git(["-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "initial"], {
        cwd: work,
      });
      await git(["remote", "add", "origin", bare], { cwd: work });
      await git(["push", "-u", "origin", "main"], { cwd: work });
      return bare;
    }

    it(
      "fires on its own tick, runs in a workspace that never existed before, and pushes scheduled/<job>/<timestamp>",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const suffix = randomUUID().slice(0, 8);
        const repoId = `repo-m9e2e-${suffix}`;
        const jobId = `job-m9e2e-${suffix}`;
        await db.insert(repos).values({
          id: repoId,
          owner: "fixture",
          name: `sched-${suffix}`,
          fullName: `fixture/sched-${suffix}`,
          defaultBranch: "main",
        });
        repoIds.push(repoId);

        // Due a moment ago, so the very first tick claims it.
        await db.insert(scheduledJobs).values({
          id: jobId,
          name: "Nightly contributing check",
          repoId,
          prompt: "add a CONTRIBUTING file",
          baseBranch: "main",
          cronExpr: "0 3 * * *",
          timezone: "UTC",
          enabled: true,
          onOverlap: "skip",
          catchup: true,
          autoPushBranch: true,
          autoOpenPr: false,
          nextRunAt: new Date(Date.now() - 1_000),
        });
        jobIds.push(jobId);

        const socketPath = join(hostDir, "gw", `${randomUUID().slice(0, 8)}.sock`);
        const fake = new FakeUpstream([
          [
            upstream.toolCall("call_1", "apply_patch", {
              patch: "*** Begin Patch\n*** Add File: CONTRIBUTING.md\n+Filed by a schedule nobody was watching.\n*** End Patch\n",
            }),
            upstream.done(1200, 80, 300),
          ],
          [upstream.delta("m1", "Added CONTRIBUTING.md."), upstream.done(400, 30)],
        ]);
        gateway = new GatewayServer({
          socketPath,
          credentials: new StaticCredentialStore(FAKE_KEY),
          upstream: fake,
          budget: { maxTurns: 10, maxCostUsd: 100, wallClockMs: 180_000 },
        });
        await gateway.listen();

        const publishDeps = {
          db,
          docker,
          githubToken: () => Promise.resolve(null),
          config: { image: TEST_IMAGE, dataDir },
          // The fixture origin is a path, so the push needs no token and no
          // network -- and it is the same publishTask milestone 7 ships.
          remoteUrl: () => originPath,
        };

        const schedulerDeps: SchedulerDeps = {
          db,
          // Resolved at fire time from the origin itself, which is exactly what
          // makes a schedule a schedule: each occurrence starts from whatever
          // the branch points at THEN, not from a SHA pinned when it was made.
          resolveBaseSha: async (_repo, branch) =>
            (await git(["--git-dir", originPath, "rev-parse", `refs/heads/${branch}`])).trim(),
          publish: (taskId, options) => publishTask(publishDeps, taskId, options),
          log: () => undefined,
        };
        const scheduler = new Scheduler({ deps: schedulerDeps, tickMs: 30_000 });

        /* ---- the tick that fires it ------------------------------------- */

        const fired = await withTimeout(scheduler.tick(), 30_000, "the firing tick");
        const mine = fired.fired.filter((f) => f.workBranch.startsWith("scheduled/nightly-contributing-check/"));
        assert.equal(mine.length, 1, `expected this job to fire; got ${JSON.stringify(fired)}`);
        const execution = mine[0];
        assert.ok(execution);
        taskIds.push(execution.taskId);
        volumes.add(workspaceVolumeName(execution.taskId));

        assert.match(execution.workBranch, /^scheduled\/nightly-contributing-check\/\d{8}T\d{6}Z$/);
        const originalBaseSha = (await git(["--git-dir", originPath, "rev-parse", "refs/heads/main"])).trim();
        assert.equal(execution.baseSha, originalBaseSha, "the occurrence pinned the branch as it was at fire time");

        /* ---- the milestone 5 run loop, unchanged ------------------------ */

        const claimed = await claimSpecific(execution.runId);
        assert.ok(
          claimed,
          `run ${execution.runId} was never claimable -- is a worker already running against ${TEST_DATABASE_URL}? ` +
            `Stop \`pnpm dev\` before running the suite; two workers share one queue by design.`,
        );

        const deps: SupervisorDeps = {
          db,
          docker,
          sandboxes: sandbox,
          mirrors: new MirrorManager({ dataDir }),
          /**
           * Milestone 8's cold tier, deliberately wired in.
           *
           * Without it the wake-after-reap branch is never even reached, and
           * the assertion below that a scheduled execution does NOT take it
           * would be vacuous. With it, the run really does ask the snapshot
           * store first -- and must be told there is nothing, because the task
           * id it is asking about was invented moments ago.
           */
          snapshots: new FsSnapshotStore(join(dataDir, "snapshots")),
          meters: gateway.meters,
          githubToken: () => Promise.resolve(null),
          model: () => Promise.resolve("gpt-5-mini"),
          cloneUrl: () => originPath,
          config: {
            image: TEST_IMAGE,
            gatewaySocketPath: socketPath,
            limits: { ...DEFAULT_LIMITS, memoryMb: 768, cpus: 1, pids: 128 },
            stopGraceMs: 5_000,
            dataDir,
          },
        };

        const outcome = await withTimeout(superviseRun(deps, claimed), TEST_TIMEOUT_MS - 30_000, "the scheduled run");
        assert.equal(outcome.status, "succeeded", `run failed: ${outcome.stopReason ?? "(no reason)"}`);

        /**
         * The fresh-workspace requirement, asserted from the transcript rather
         * than from the code that was supposed to honour it.
         *
         * There are exactly two ways a run could inherit a workspace, and both
         * are ruled out here in the words the host itself logged:
         *
         *   hot  -- "reusing the warm workspace" (milestone 5's warm volume)
         *   cold -- a restore from the snapshot store (milestone 8's wake path)
         *
         * The cold one is the subtle one, because it fires precisely when a
         * task has no hot volume -- which is exactly what a scheduled execution
         * looks like from the outside. It is safe anyway, and structurally
         * rather than by luck: `restoreWorkspace` is keyed on `taskId`, and this
         * occurrence invented its own moments ago, so there is nothing filed
         * under it. The run says as much out loud, and that line is asserted --
         * along with the line before it, so this cannot pass by the cold branch
         * never having been reached at all.
         */
        const rows = await readEvents(db, execution.taskId);
        const setupLog = rows
          .filter((r) => r.type === "setup_log")
          .map((r) => (r.payload as { text: string }).text)
          .join("");
        assert.match(setupLog, /seeding ws-/, `the workspace should have been seeded fresh:\n${setupLog}`);
        assert.doesNotMatch(setupLog, /reusing the warm workspace/, "a scheduled execution must not inherit a workspace");
        assert.match(
          setupLog,
          /checking the cold snapshot store/,
          `the cold tier is wired in above, so the wake path must have been reached:\n${setupLog}`,
        );
        assert.match(
          setupLog,
          /no cold snapshot either; this workspace is new/,
          `a scheduled execution must never wake into a workspace that was not its own:\n${setupLog}`,
        );

        const [task] = await db.select().from(tasks).where(eq(tasks.id, execution.taskId));
        assert.equal(task?.volumeName, workspaceVolumeName(execution.taskId));
        assert.equal(task?.workBranch, execution.workBranch, "the run used the schedule's branch name, not codex/*");

        // The link back, which is what lets a task page say where it came from.
        const [run] = await db.select().from(runs).where(eq(runs.id, execution.runId));
        assert.equal(run?.scheduledExecutionId, execution.executionId);
        assert.equal(run?.status, "succeeded");
        /**
         * A real container really ran: these tokens were metered by the host
         * gateway, which only the agent loop inside the sandbox calls. `fake`
         * is what answered it, so the numbers are free and no key left the
         * host -- which is the property that moving the model call out of the
         * container bought in the first place.
         */
        assert.equal(run?.inputTokens, 1600);
        assert.equal(run?.outputTokens, 110);
        assert.equal(JSON.stringify(rows).includes(FAKE_KEY), false);
        assert.equal(fake.lastApiKey, FAKE_KEY);
        assert.ok(
          rows.some((r) => r.type === "tool_call"),
          "the transcript should carry the agent's own tool calls",
        );

        /* ---- the tick that settles and pushes --------------------------- */

        const settled = await withTimeout(scheduler.tick(), 120_000, "the settling tick");
        const closed = settled.settled.filter((s) => s.executionId === execution.executionId);
        assert.equal(closed.length, 1, `expected this execution to settle; got ${JSON.stringify(settled.settled)}`);
        assert.equal(closed[0]?.status, "succeeded");
        assert.match(closed[0]?.reason ?? "", new RegExp(`pushed ${execution.workBranch}`));

        // The branch is really on the origin and really carries the file --
        // the whole point of auto-push is that the work outlives the container.
        const pushedSha = (
          await git(["--git-dir", originPath, "rev-parse", `refs/heads/${execution.workBranch}`])
        ).trim();
        assert.notEqual(pushedSha, originalBaseSha, "the pushed branch must be ahead of the base it started from");
        const tree = await git(["--git-dir", originPath, "ls-tree", "--name-only", pushedSha]);
        assert.ok(tree.split("\n").includes("CONTRIBUTING.md"), `origin tree: ${tree}`);

        const [stored] = await db.select().from(scheduledExecutions).where(eq(scheduledExecutions.id, execution.executionId));
        assert.equal(stored?.status, "succeeded");
        assert.equal(stored?.taskId, execution.taskId);

        // ...and the job is back on cadence rather than stuck on the occurrence
        // it just ran.
        const [job] = await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, jobId));
        assert.ok(job && job.nextRunAt.getTime() > Date.now(), `next_run_at: ${job?.nextRunAt.toISOString()}`);
        assert.ok(job?.lastRunAt, "lastRunAt should record that this job has actually run");
      },
    );

    /**
     * Claims until OUR run comes up, then puts anything else it picked up back.
     *
     * The queue is global and a developer's database may already hold queued
     * runs from real use; the test must not depend on being alone, and must not
     * swallow someone else's work either.
     */
    async function claimSpecific(runId: string) {
      const parked: Array<{ runId: string; taskId: string }> = [];
      let mine: Awaited<ReturnType<typeof claimNextRun>> = null;
      for (let attempt = 0; attempt < 25 && !mine; attempt += 1) {
        const claimed = await claimNextRun(db, "m9-int-test-worker");
        if (!claimed) break;
        if (claimed.runId === runId) mine = claimed;
        else parked.push(claimed);
      }
      for (const run of parked) {
        await db.update(runs).set({ status: "queued", claimedBy: null, startedAt: null }).where(eq(runs.id, run.runId));
        await db.update(tasks).set({ status: "queued" }).where(eq(tasks.id, run.taskId));
      }
      return mine;
    }
  },
);
