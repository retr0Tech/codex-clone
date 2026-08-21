import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import Docker from "dockerode";
import { eq } from "drizzle-orm";
import { DEFAULT_LIMITS } from "@codex-clone/core";
import { createDb, readEvents, repos, runs, snapshots, tasks, type Database } from "@codex-clone/db";
import { MirrorManager } from "@codex-clone/github";
import {
  acquireDockerTestLock,
  DockerSandbox,
  FrameDemuxer,
  removeVolume,
  volumeExists,
  workspaceVolumeName,
  type DockerTestLock,
} from "@codex-clone/sandbox-docker";
import { StaticCredentialStore } from "../gateway/credentials.js";
import { FakeUpstream, upstream } from "../gateway/fake-upstream.js";
import { GatewayServer } from "../gateway/server.js";
import { claimNextRun } from "../runner/claim.js";
import { git } from "../runner/git.js";
import { superviseRun, type SupervisorDeps } from "../runner/supervisor.js";
import {
  TEST_DATABASE_URL,
  TEST_DOCKER_SOCKET,
  TEST_IMAGE,
  dockerUnavailable,
  postgresUnavailable,
  withTimeout,
} from "../runner/testing.js";
import { FsSnapshotStore } from "../snapshots/fs-store.js";
import { archiveTask, rebaseOntoBase, unarchiveTask, type ArchiveDeps } from "./archive.js";
import { IdleReaper, ReapBusyError, idleCandidates, reapTask } from "./reaper.js";

/**
 * Milestone 8, end to end: reap, then wake.
 *
 *   run turn 1 ──▶ ws-<taskId> holds committed + uncommitted work
 *        │  idle
 *        ▼
 *   reaper ──▶ <taskId>.tar.zst in the cold store, hot volume GONE
 *        │  follow-up turn
 *        ▼
 *   wake ──▶ fresh volume, byte-identical tracked content, agent works on it
 *
 * PLAN.md §7 lists exactly one risk against this milestone: "cold-restore path
 * is rarely exercised → needs a reap/wake integration test". This is that test.
 * It is the only thing standing between a working restore and a restore that
 * quietly stopped working three refactors ago, so it asserts the property that
 * matters -- **the restored workspace is byte-identical** -- rather than
 * asserting that some functions were called.
 *
 * Everything is real except the model. `FakeUpstream` means no API key, no
 * egress, and no spend; the origin is a bare git repository on local disk, so
 * the mirror-then-clone path is the production one without github.com.
 *
 * Skips cleanly, with a reason, when Docker or Postgres is absent. Every wait
 * is bounded: a restore that stalls must fail the suite, not hang it.
 */

const TEST_TIMEOUT_MS = 300_000;
const FAKE_KEY = "sk-test-not-a-real-key-000000000000";
/** Big and incompressible: proof that the excludes did something. */
const NODE_MODULES_BYTES = 4 * 1024 * 1024;

const skip = (await dockerUnavailable()) || (await postgresUnavailable());

describe(
  "the cold tier: reap an idle workspace, then wake it back",
  { skip: skip === false ? undefined : skip },
  () => {
    let docker: Docker;
    let db: Database;
    let closeDb: () => Promise<unknown>;
    let sandbox: DockerSandbox;
    let hostDir: string;
    let dataDir: string;
    let store: FsSnapshotStore;
    let originPath: string;
    let originWork: string;
    let baseSha: string;
    let lock: DockerTestLock;

    const repoIds: string[] = [];
    const taskIds: string[] = [];
    const volumes = new Set<string>();
    const gateways = new Set<GatewayServer>();

    before(async () => {
      lock = await acquireDockerTestLock();
      docker = new Docker({ socketPath: TEST_DOCKER_SOCKET });
      ({ db, close: closeDb } = createDb(TEST_DATABASE_URL));
      await withTimeout(db.execute("select 1"), 10_000, "connecting to Postgres");

      // Under $HOME: Docker Desktop's file-sharing allowlist covers /Users but
      // not /private/var/folders, and the gateway socket must be bind-mountable.
      hostDir = await realpath(await mkdtemp(join(homedir(), ".codexclone-m8-")));
      dataDir = join(hostDir, "data");
      await mkdir(join(hostDir, "gw"), { recursive: true, mode: 0o700 });
      await mkdir(join(dataDir, "jobs"), { recursive: true, mode: 0o700 });
      // The store lives inside the temp dir, so the suite cannot leave a
      // snapshot behind in ~/.codexclone/snapshots.
      store = new FsSnapshotStore(join(dataDir, "snapshots"));
      sandbox = new DockerSandbox({ socketPath: TEST_DOCKER_SOCKET, jobSpecDir: join(dataDir, "jobs") });

      ({ originPath, originWork, baseSha } = await createOriginRepo(join(hostDir, "origin")));
    });

    after(async () => {
      for (const gateway of gateways) await gateway.close().catch(() => undefined);
      for (const volume of volumes) await removeVolume(docker, volume, { force: true }).catch(() => undefined);
      if (db) {
        for (const taskId of taskIds) {
          // events, runs and snapshots all cascade from tasks; repos do not.
          await db.delete(tasks).where(eq(tasks.id, taskId)).catch(() => undefined);
        }
        for (const repoId of repoIds) await db.delete(repos).where(eq(repos.id, repoId)).catch(() => undefined);
      }
      await closeDb?.().catch(() => undefined);
      if (hostDir) await rm(hostDir, { recursive: true, force: true }).catch(() => undefined);
      await lock?.release().catch(() => undefined);
    });

    /** A real git repository on local disk, standing in for github.com. */
    async function createOriginRepo(
      root: string,
    ): Promise<{ originPath: string; originWork: string; baseSha: string }> {
      const bare = join(root, "origin.git");
      const work = join(root, "work");
      await mkdir(work, { recursive: true });
      await git(["init", "--bare", "--initial-branch=main", bare]);
      await git(["init", "--initial-branch=main", work]);
      await writeFile(join(work, "README.md"), "# fixture\n\nA repository the agent will edit.\n");
      await git(["add", "-A"], { cwd: work });
      await git(["-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "initial"], {
        cwd: work,
      });
      await git(["remote", "add", "origin", bare], { cwd: work });
      await git(["push", "-u", "origin", "main"], { cwd: work });
      const sha = (await git(["rev-parse", "HEAD"], { cwd: work })).trim();
      return { originPath: bare, originWork: work, baseSha: sha };
    }

    async function seedTask(prompt: string): Promise<{ taskId: string; runId: string; repoId: string }> {
      const suffix = randomUUID().slice(0, 8);
      const repoId = `repo-m8-${suffix}`;
      const taskId = `task-m8-${suffix}`;
      const runId = `run-m8-${suffix}`;

      await db.insert(repos).values({
        id: repoId,
        owner: "fixture",
        name: `repo-${suffix}`,
        fullName: `fixture/repo-${suffix}`,
        defaultBranch: "main",
      });
      await db.insert(tasks).values({
        id: taskId,
        repoId,
        title: prompt.slice(0, 40),
        mode: "code",
        baseBranch: "main",
        baseSha,
        status: "queued",
      });
      await db.insert(runs).values({ id: runId, taskId, prompt, status: "queued" });

      repoIds.push(repoId);
      taskIds.push(taskId);
      volumes.add(workspaceVolumeName(taskId));
      return { taskId, runId, repoId };
    }

    /** Queues a follow-up turn the way `POST /api/tasks/:id` does. */
    async function queueFollowUp(taskId: string): Promise<string> {
      const runId = `run-m8-${randomUUID().slice(0, 8)}`;
      await db.insert(runs).values({ id: runId, taskId, prompt: "follow up", status: "queued" });
      await db.update(tasks).set({ status: "queued", lastActivityAt: new Date() }).where(eq(tasks.id, taskId));
      return runId;
    }

    function makeDeps(turns: ConstructorParameters<typeof FakeUpstream>[0]): {
      deps: SupervisorDeps;
      gateway: GatewayServer;
    } {
      const socketPath = join(hostDir, "gw", `${randomUUID().slice(0, 8)}.sock`);
      const gateway = new GatewayServer({
        socketPath,
        credentials: new StaticCredentialStore(FAKE_KEY),
        upstream: new FakeUpstream(turns),
        budget: { maxTurns: 10, maxCostUsd: 100, wallClockMs: 180_000 },
      });
      gateways.add(gateway);

      const deps: SupervisorDeps = {
        db,
        docker,
        sandboxes: sandbox,
        mirrors: new MirrorManager({ dataDir }),
        // The wake half of the two-tier store. Without this a reaped task would
        // silently re-clone at the base commit and lose the agent's work.
        snapshots: store,
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
      return { deps, gateway };
    }

    /**
     * Reaper deps scoped to ONE task.
     *
     * `isRunning` returning true for every other task is the whole trick: the
     * queue is shared through a real Postgres, and a developer's database may
     * hold idle tasks from real use. A sweep that reaped those would destroy
     * their workspaces. Lying about them being busy exercises the real sweep --
     * candidate query, guards, ordering -- while it can only ever act on ours.
     */
    function makeReaperDeps(taskId: string, extra: { idleReapMs?: number } = {}): ArchiveDeps {
      return {
        db,
        docker,
        store,
        mirrors: new MirrorManager({ dataDir }),
        githubToken: () => Promise.resolve(null),
        cloneUrl: () => originPath,
        config: {
          image: TEST_IMAGE,
          dataDir,
          idleReapMs: extra.idleReapMs ?? 15 * 60 * 1000,
          pollMs: 50,
        },
        isRunning: (candidate) => candidate !== taskId,
        log: () => undefined,
      };
    }

    /** Claims until OUR run comes up, then puts anything else it picked up back. */
    async function claimSpecific(runId: string) {
      const parked: Array<{ runId: string; taskId: string }> = [];
      let mine: Awaited<ReturnType<typeof claimNextRun>> = null;
      for (let attempt = 0; attempt < 25 && !mine; attempt += 1) {
        const claimed = await claimNextRun(db, "m8-test-worker");
        if (!claimed) break;
        if (claimed.runId === runId) mine = claimed;
        else parked.push(claimed);
      }
      for (const run of parked) {
        await db.update(runs).set({ status: "queued", claimedBy: null, startedAt: null }).where(eq(runs.id, run.runId));
        await db.update(tasks).set({ status: "queued" }).where(eq(tasks.id, run.taskId));
      }
      assert.ok(
        mine,
        `run ${runId} was never claimable -- is a worker already running against ${TEST_DATABASE_URL}? ` +
          `Stop \`pnpm dev\` before running the suite; two workers share one queue by design.`,
      );
      return mine;
    }

    /** The first turn every test needs: a task with a real, dirty workspace. */
    async function runFirstTurn(prompt: string): Promise<{ taskId: string; runId: string }> {
      const seeded = await seedTask(prompt);
      const { deps, gateway } = makeDeps([
        [
          upstream.toolCall("call_1", "apply_patch", {
            patch: "*** Begin Patch\n*** Add File: CONTRIBUTING.md\n+Run the tests with `npm test`.\n*** End Patch\n",
          }),
          upstream.done(1200, 80, 300),
        ],
        [upstream.delta("m1", "Added CONTRIBUTING.md."), upstream.done(400, 30)],
      ]);
      await gateway.listen();

      const claimed = await claimSpecific(seeded.runId);
      const outcome = await withTimeout(superviseRun(deps, claimed), TEST_TIMEOUT_MS - 30_000, "the first turn");
      assert.equal(outcome.status, "succeeded", `first turn failed: ${outcome.stopReason ?? "(no reason)"}`);
      return { taskId: seeded.taskId, runId: seeded.runId };
    }

    /** Marks the task idle for longer than any TTL the tests use. */
    async function makeIdle(taskId: string, ageMs = 60 * 60 * 1000): Promise<Date> {
      const when = new Date(Date.now() - ageMs);
      await db.update(tasks).set({ status: "idle", lastActivityAt: when }).where(eq(tasks.id, taskId));
      return when;
    }

    it(
      "reaps an idle workspace to the cold tier and wakes it back byte-identically",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const { taskId } = await runFirstTurn("add a CONTRIBUTING file");
        const volumeName = workspaceVolumeName(taskId);

        /**
         * Make the workspace look like a real one that has been worked in: a
         * committed file, an UNCOMMITTED edit, an untracked scratch file, an
         * executable bit, and four incompressible megabytes of node_modules
         * that must not survive the round trip.
         */
        await runInVolume(
          docker,
          volumeName,
          [
            "set -eu",
            "cd /workspace",
            "printf '\\n\\nEdited by the agent, never committed.\\n' >> README.md",
            "mkdir -p scratch bin node_modules/big",
            "printf 'a note the agent left behind\\n' > scratch/notes.txt",
            "printf '#!/bin/sh\\necho hi\\n' > bin/tool.sh",
            "chmod 755 bin/tool.sh",
            `head -c ${NODE_MODULES_BYTES} /dev/urandom > node_modules/big/blob.bin`,
          ].join("\n"),
        );

        const before = await snapshotOfVolume(docker, volumeName);
        assert.ok(before.files.has("./CONTRIBUTING.md"), "the agent's committed file should be there");
        assert.ok(before.files.has("./scratch/notes.txt"));
        assert.equal(before.modes.get("./bin/tool.sh"), "755");
        assert.match(before.status, /^ M README\.md$/m, "the uncommitted edit is what restore must preserve");
        assert.match(before.status, /\?\? scratch\//m);

        const idleSince = await makeIdle(taskId);

        // ---------------------------------------------------------------
        // reap
        // ---------------------------------------------------------------
        const reaperDeps = makeReaperDeps(taskId);

        // The candidate query finds it, and would not have a minute ago.
        const candidates = await idleCandidates(db, reaperDeps.config.idleReapMs);
        assert.ok(
          candidates.some((c) => c.taskId === taskId && c.volumeName === volumeName),
          "an idle task with a hot volume should be a reap candidate",
        );
        assert.equal(
          (await idleCandidates(db, 90 * 60 * 1000)).some((c) => c.taskId === taskId),
          false,
          "and should not be, under a TTL longer than it has been idle",
        );

        // The real sweep, not a hand-rolled call: the timer loop is the thing
        // that runs in production, and `isRunning` scopes it to this task.
        const reaper = new IdleReaper(reaperDeps);
        const outcomes = await withTimeout(reaper.sweep(), 120_000, "the reaper sweep");
        const mine = outcomes.find((o) => o.taskId === taskId);
        assert.ok(mine, `the sweep did not consider ${taskId}; it saw ${outcomes.map((o) => o.taskId).join(", ")}`);
        assert.equal(mine.reaped, true, `reap skipped: ${mine.skipped ?? "(no reason)"}`);
        await reaper.stop();

        // The hot tier is gone...
        assert.equal(await volumeExists(docker, volumeName), false, "the hot volume must be removed after the export");
        const [afterReap] = await db.select().from(tasks).where(eq(tasks.id, taskId));
        assert.equal(afterReap?.volumeName, null, "volume_name is the 'this task is cold' marker");
        assert.equal(afterReap?.status, "idle", "reaping is not archiving; the task is still an ordinary task");
        assert.equal(afterReap?.lastActivityAt.getTime(), idleSince.getTime(), "a reap is not activity");

        // ...and the cold tier holds it, recorded in the table the schema
        // already had.
        const meta = await store.head(taskId);
        assert.ok(meta, "the cold store should hold a snapshot");
        assert.match(meta.digest, /^sha256:[0-9a-f]{64}$/);
        assert.equal(meta.sizeBytes, (await stat(store.pathFor(taskId))).size);

        const [record] = await db.select().from(snapshots).where(eq(snapshots.taskId, taskId));
        assert.ok(record, "the snapshots row is what the UI reads");
        assert.equal(record.digest, meta.digest);
        assert.equal(record.sizeBytes, meta.sizeBytes);
        assert.equal(record.storePath, store.pathFor(taskId));

        /**
         * The excludes are not decoration. Four megabytes of incompressible
         * random data went into node_modules; if any of it were in the archive
         * the snapshot could not be this small.
         */
        assert.ok(
          meta.sizeBytes < NODE_MODULES_BYTES / 8,
          `snapshot is ${meta.sizeBytes} bytes: node_modules was not excluded`,
        );

        // ---------------------------------------------------------------
        // wake
        // ---------------------------------------------------------------
        const followUpId = await queueFollowUp(taskId);
        const { deps, gateway } = makeDeps([
          // Reads the uncommitted edit: proof the agent sees the workspace it
          // left behind rather than a clean checkout of the base commit.
          [upstream.toolCall("call_a", "shell", { command: "cat README.md" }), upstream.done(900, 40)],
          [
            upstream.toolCall("call_b", "apply_patch", {
              patch: "*** Begin Patch\n*** Add File: FOLLOWUP.md\n+Written after the wake.\n*** End Patch\n",
            }),
            upstream.done(900, 40),
          ],
          [upstream.delta("m2", "Read the workspace and added FOLLOWUP.md."), upstream.done(400, 30)],
        ]);
        await gateway.listen();

        const claimed = await claimSpecific(followUpId);
        const outcome = await withTimeout(superviseRun(deps, claimed), TEST_TIMEOUT_MS - 60_000, "the wake turn");
        assert.equal(outcome.status, "succeeded", `the follow-up failed: ${outcome.stopReason ?? "(no reason)"}`);

        // The transcript says where the workspace came from. A restore that
        // silently fell through to a fresh clone would look identical in every
        // other assertion below except the ones about uncommitted work.
        const rows = await readEvents(db, taskId);
        // Scoped to the follow-up RUN: the transcript is per-task and
        // append-only, so run 1's log legitimately says the workspace was new.
        const setupText = rows
          .filter((r) => r.type === "setup_log" && r.runId === followUpId)
          .map((r) => (r.payload as { text: string }).text)
          .join("");
        assert.match(setupText, /cold snapshot/i, `setup log never mentions the cold tier:\n${setupText}`);
        assert.match(setupText, /workspace restored into/i);
        assert.doesNotMatch(setupText, /this workspace is new/, "it must NOT have fallen back to a fresh clone");

        // The agent really read the uncommitted edit, from inside the container.
        const shellResult = rows.find(
          (r) => r.type === "tool_result" && (r.payload as { callId: string }).callId === "call_a",
        );
        assert.ok(shellResult, "the shell tool result should be in the transcript");
        const shellPayload = shellResult.payload as { ok: boolean; output: string };
        assert.equal(shellPayload.ok, true);
        assert.match(
          shellPayload.output,
          /Edited by the agent, never committed\./,
          "the restored workspace must carry work that was never committed",
        );

        // ---------------------------------------------------------------
        // byte-equivalence
        // ---------------------------------------------------------------
        const restored = await snapshotOfVolume(docker, volumeName);

        assert.equal(restored.head, before.head, "HEAD must not have moved across the round trip");
        assert.equal(restored.branch, before.branch, "the work branch must survive");
        // node_modules is excluded from the snapshot by design, and the
        // follow-up turn wrote one new file; everything else git reports must
        // be identical, including the modified-but-uncommitted README.
        assert.deepEqual(
          statusLines(restored.status, [/FOLLOWUP\.md/, /node_modules/]),
          statusLines(before.status, [/node_modules/]),
          "git's own account of the working tree must be unchanged",
        );

        for (const [path, digest] of before.files) {
          assert.equal(restored.files.get(path), digest, `${path} did not survive the round trip byte-for-byte`);
        }
        const added = [...restored.files.keys()].filter((p) => !before.files.has(p));
        assert.deepEqual(added, ["./FOLLOWUP.md"], "the only new file should be the one the follow-up turn wrote");
        assert.equal(restored.modes.get("./bin/tool.sh"), "755", "the executable bit must survive");

        // node_modules is gone, as designed: the setup script rebuilds it, and
        // this fixture repo has none configured.
        assert.equal(restored.files.has("./node_modules/big/blob.bin"), false);

        // The task is warm again and points at a live volume.
        const [afterWake] = await db.select().from(tasks).where(eq(tasks.id, taskId));
        assert.equal(afterWake?.volumeName, volumeName);
        assert.equal(afterWake?.status, "idle");
        assert.equal(await volumeExists(docker, volumeName), true);

        // The cold copy is KEPT, not consumed (PLAN.md §3.10).
        assert.ok(await store.head(taskId), "the snapshot must survive being restored from");
      },
    );

    it(
      "never reaps a task with a run in flight",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const { taskId } = await runFirstTurn("do not reap me");
        const volumeName = workspaceVolumeName(taskId);
        await makeIdle(taskId);

        // 1. This worker knows it is running something, before the database does.
        const believesBusy = { ...makeReaperDeps(taskId), isRunning: () => true };
        await assert.rejects(
          () => reapTask(believesBusy, taskId, { trigger: "idle" }),
          (error: unknown) => error instanceof ReapBusyError && /run in flight/.test((error as Error).message),
        );
        assert.equal(await volumeExists(docker, volumeName), true, "the workspace must be untouched");

        // 2. Another worker has queued a follow-up. The database is the only
        //    place that fact exists.
        const queuedId = await queueFollowUp(taskId);
        await makeIdle(taskId);
        await assert.rejects(
          () => reapTask(makeReaperDeps(taskId), taskId, { trigger: "idle" }),
          (error: unknown) => error instanceof ReapBusyError && /queued or running/.test((error as Error).message),
        );
        assert.equal(await volumeExists(docker, volumeName), true);
        assert.equal(await store.head(taskId), null, "nothing should have been written to the cold tier");

        // 3. And the sweep skips it rather than crashing.
        const reaper = new IdleReaper(makeReaperDeps(taskId));
        const outcomes = await withTimeout(reaper.sweep(), 60_000, "the guarded sweep");
        await reaper.stop();
        assert.equal(outcomes.find((o) => o.taskId === taskId)?.reaped, false);

        await db.delete(runs).where(eq(runs.id, queuedId));

        // 4. A task that has not been idle long enough is left alone even
        //    though nothing else is wrong with it.
        await db.update(tasks).set({ status: "idle", lastActivityAt: new Date() }).where(eq(tasks.id, taskId));
        const fresh = await reapTask(makeReaperDeps(taskId), taskId, { trigger: "idle" });
        assert.equal(fresh.reaped, false);
        assert.match(fresh.skipped ?? "", /only idle for/);
        assert.equal(await volumeExists(docker, volumeName), true);
      },
    );

    it(
      "archives with the transcript intact, and restores into a working follow-up turn",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const { taskId } = await runFirstTurn("archive me");
        const volumeName = workspaceVolumeName(taskId);
        const eventsBefore = await readEvents(db, taskId);
        assert.ok(eventsBefore.length > 0);

        await db.update(tasks).set({ status: "idle" }).where(eq(tasks.id, taskId));
        const deps = makeReaperDeps(taskId);

        // Archive does not wait for the idle TTL: the user pressed a button.
        const archived = await withTimeout(archiveTask(deps, taskId), 120_000, "archiving");
        assert.equal(archived.status, "archived");
        assert.equal(archived.snapshotted, true);
        assert.ok((archived.sizeBytes ?? 0) > 0);

        const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
        assert.equal(row?.status, "archived");
        assert.ok(row?.archivedAt, "archived_at is what the /archived page sorts on");
        assert.equal(row?.volumeName, null);
        assert.equal(await volumeExists(docker, volumeName), false);

        // "Archive is a status change, not a deletion." The event log is
        // retained in full and the snapshot is kept.
        assert.deepEqual(await readEvents(db, taskId), eventsBefore, "the transcript must be untouched");
        assert.ok(await store.head(taskId));

        // An archived task is unclaimable, so a stray queued run cannot wake it.
        const strayId = await queueFollowUp(taskId);
        await db.update(tasks).set({ status: "archived" }).where(eq(tasks.id, taskId));
        for (let i = 0; i < 5; i += 1) {
          const claimed = await claimNextRun(db, "m8-archived-probe");
          if (!claimed) break;
          assert.notEqual(claimed.taskId, taskId, "an archived task must not be claimable");
          await db.update(runs).set({ status: "queued", claimedBy: null, startedAt: null }).where(eq(runs.id, claimed.runId));
          await db.update(tasks).set({ status: "queued" }).where(eq(tasks.id, claimed.taskId));
        }
        await db.delete(runs).where(eq(runs.id, strayId));

        // Archiving twice is not an error.
        assert.equal((await archiveTask(deps, taskId)).status, "archived");

        // Restore. The workspace itself comes back lazily, through the same
        // wake path the reaper's test exercises -- one code path, not two.
        const restored = await unarchiveTask(deps, taskId);
        assert.equal(restored.status, "idle");
        assert.equal(restored.hasSnapshot, true);
        assert.ok(restored.snapshotTakenAt);

        const [back] = await db.select().from(tasks).where(eq(tasks.id, taskId));
        assert.equal(back?.status, "idle");
        assert.equal(back?.archivedAt, null, "an unarchived task must not still look archived");

        // ...and a follow-up turn really works against it.
        const followUpId = await queueFollowUp(taskId);
        const { deps: runDeps, gateway } = makeDeps([
          [upstream.toolCall("call_c", "read_file", { path: "CONTRIBUTING.md" }), upstream.done(900, 40)],
          [upstream.delta("m3", "Still here."), upstream.done(400, 30)],
        ]);
        await gateway.listen();

        const claimed = await claimSpecific(followUpId);
        const outcome = await withTimeout(superviseRun(runDeps, claimed), TEST_TIMEOUT_MS - 60_000, "the restored turn");
        assert.equal(outcome.status, "succeeded", `the restored follow-up failed: ${outcome.stopReason ?? ""}`);

        const result = (await readEvents(db, taskId)).find(
          (r) => r.type === "tool_result" && (r.payload as { callId: string }).callId === "call_c",
        );
        assert.match(
          (result?.payload as { output: string }).output,
          /Run the tests with/,
          "the restored workspace should still hold the file the first turn wrote",
        );
        assert.equal(await volumeExists(docker, volumeName), true);
      },
    );

    it(
      "rebases onto the latest base branch only when asked, and moves the pin with it",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const { taskId } = await runFirstTurn("rebase me");
        const volumeName = workspaceVolumeName(taskId);
        await db.update(tasks).set({ status: "idle" }).where(eq(tasks.id, taskId));
        const deps = makeReaperDeps(taskId);

        // Nothing moved yet: the button is honest about doing nothing.
        const noop = await withTimeout(rebaseOntoBase(deps, taskId), 120_000, "the no-op rebase");
        assert.equal(noop.rebased, false);
        assert.equal(noop.baseSha, baseSha);

        // Somebody else lands a commit on main.
        await writeFile(join(originWork, "UPSTREAM.md"), "landed while the task was open\n");
        await git(["add", "-A"], { cwd: originWork });
        await git(["-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "upstream"], {
          cwd: originWork,
        });
        await git(["push", "origin", "main"], { cwd: originWork });
        const movedTo = (await git(["--git-dir", originPath, "rev-parse", "refs/heads/main"])).trim();
        assert.notEqual(movedTo, baseSha);

        // Restoring is explicitly NOT a rebase (PLAN.md §3.10), so the pin is
        // still where it was until the user asks.
        const [beforeRebase] = await db.select().from(tasks).where(eq(tasks.id, taskId));
        assert.equal(beforeRebase?.baseSha, baseSha, "nothing may rebase a workspace on its own");

        const result = await withTimeout(rebaseOntoBase(deps, taskId), 120_000, "the rebase");
        assert.equal(result.rebased, true);
        assert.equal(result.previousBaseSha, baseSha);
        assert.equal(result.baseSha, movedTo);

        // The pin moved with it. Every diff is derived against `base_sha`, so
        // leaving it behind would credit the agent with the upstream commit.
        const [afterRebase] = await db.select().from(tasks).where(eq(tasks.id, taskId));
        assert.equal(afterRebase?.baseSha, movedTo);

        // The workspace really is on top of the new base, with both files.
        const state = await runInVolume(
          docker,
          volumeName,
          [
            "set -eu",
            "cd /workspace",
            "git -c safe.directory=/workspace log --format=%H -n 5",
            "echo ---",
            "ls CONTRIBUTING.md UPSTREAM.md",
          ].join("\n"),
        );
        assert.ok(state.includes(movedTo), `the rebased branch should contain ${movedTo}:\n${state}`);
        assert.match(state, /CONTRIBUTING\.md/, "the agent's work must survive the rebase");
        assert.match(state, /UPSTREAM\.md/, "and the upstream commit must be underneath it");
      },
    );
  },
);

interface VolumeSnapshot {
  head: string;
  branch: string;
  status: string;
  /** Repo-relative path -> sha256 of its bytes. `.git` and node_modules excluded. */
  files: Map<string, string>;
  /** Repo-relative path -> octal mode. */
  modes: Map<string, string>;
}

/**
 * What is REALLY in the volume, hashed file by file.
 *
 * The point of the milestone is that a restored workspace is the archived one,
 * so the test has to compare content rather than trust either side's account of
 * it -- the same principle the derived diff rests on. `.git` is excluded from
 * the hashes (its index and reflogs move on every command) and probed through
 * git itself instead, which is the honest test of whether history survived.
 */
async function snapshotOfVolume(docker: Docker, volumeName: string): Promise<VolumeSnapshot> {
  const output = await runInVolume(
    docker,
    volumeName,
    [
      "set -eu",
      "cd /workspace",
      "git -c safe.directory=/workspace rev-parse HEAD",
      "git -c safe.directory=/workspace rev-parse --abbrev-ref HEAD",
      "echo '--- status'",
      "git -c safe.directory=/workspace status --porcelain=v1",
      "echo '--- files'",
      "find . -path ./.git -prune -o -path ./node_modules -prune -o -type f -print0 | sort -z | xargs -0 -r sha256sum",
      "echo '--- modes'",
      "find . -path ./.git -prune -o -path ./node_modules -prune -o -type f -printf '%m %p\\n' | sort",
    ].join("\n"),
  );

  const [headBlock, statusBlock, filesBlock, modesBlock] = splitSections(output);
  const [head = "", branch = ""] = headBlock.split("\n");

  const files = new Map<string, string>();
  for (const line of filesBlock.split("\n")) {
    const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
    if (match) files.set(match[2] as string, match[1] as string);
  }

  const modes = new Map<string, string>();
  for (const line of modesBlock.split("\n")) {
    const match = /^(\d{3,4})\s+(.+)$/.exec(line.trim());
    if (match) modes.set(match[2] as string, (match[1] as string).slice(-3));
  }

  return { head: head.trim(), branch: branch.trim(), status: statusBlock, files, modes };
}

/**
 * Trailing whitespace only. `git status --porcelain` is column-significant --
 * " M README.md" and "?? README.md" differ by a leading space -- so trimming
 * both ends would quietly erase the distinction this test rests on.
 */
function splitSections(output: string): [string, string, string, string] {
  const parts = output.split(/^--- (?:status|files|modes)$/m).map((s) => s.replace(/^\r?\n/, "").replace(/\s+$/, ""));
  return [parts[0] ?? "", parts[1] ?? "", parts[2] ?? "", parts[3] ?? ""];
}

/** Porcelain lines, minus the ones a test expects to differ. */
function statusLines(status: string, ignore: RegExp[]): string[] {
  return status
    .split("\n")
    .filter((line) => line !== "" && !ignore.some((pattern) => pattern.test(line)));
}

/**
 * Runs one command against a workspace volume, as the agent's uid.
 *
 * Bounded, and it always removes its container -- a test that leaks one holds a
 * lock on the volume and makes the NEXT test's reap fail for a reason that has
 * nothing to do with the reaper.
 */
async function runInVolume(docker: Docker, volumeName: string, command: string): Promise<string> {
  const container = await docker.createContainer({
    Image: TEST_IMAGE,
    Entrypoint: [],
    Cmd: ["sh", "-c", command],
    User: "10001:10001",
    HostConfig: {
      Mounts: [{ Type: "volume", Source: volumeName, Target: "/workspace", ReadOnly: false }],
      NetworkMode: "none",
      AutoRemove: false,
    },
  });
  try {
    await container.start();
    const result = (await withTimeout(container.wait(), 60_000, `command in volume ${volumeName}`)) as {
      StatusCode?: number;
    };
    const logs = (await container.logs({ stdout: true, stderr: true })) as unknown as Buffer;
    let out = "";
    for (const frame of new FrameDemuxer().push(Buffer.from(logs))) out += frame.data.toString("utf8");
    if (result.StatusCode !== 0) {
      throw new Error(`command in ${volumeName} exited ${result.StatusCode}:\n${command}\n---\n${out}`);
    }
    return out;
  } finally {
    await container.remove({ force: true, v: false }).catch(() => undefined);
  }
}
