import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import Docker from "dockerode";
import { eq } from "drizzle-orm";
import { DEFAULT_LIMITS } from "@codex-clone/core";
import { appendEvent, createDb, events, readEvents, repos, runs, tasks, type Database } from "@codex-clone/db";
import { MirrorManager } from "@codex-clone/github";
import {
  acquireDockerTestLock,
  DockerSandbox,
  FrameDemuxer,
  removeVolume,
  workspaceVolumeName,
  type DockerTestLock,
} from "@codex-clone/sandbox-docker";
import { StaticCredentialStore } from "../gateway/credentials.js";
import { FakeUpstream, upstream } from "../gateway/fake-upstream.js";
import { GatewayServer } from "../gateway/server.js";
import { claimNextRun } from "./claim.js";
import { superviseRun, type SupervisorDeps } from "./supervisor.js";
import { PublishError, publishTask } from "./publish.js";
import { git } from "./git.js";
import {
  TEST_DATABASE_URL,
  TEST_DOCKER_SOCKET,
  TEST_IMAGE,
  dockerUnavailable,
  postgresUnavailable,
  withTimeout,
} from "./testing.js";

/**
 * Milestone 5, end to end, with everything real except the model.
 *
 *   git repo on disk ──▶ mirror ──▶ ws-<taskId> volume ──▶ real container
 *          ▲                                                    │
 *          └──────── host derives nothing it was told ──────────┘
 *                                    │
 *                    Postgres: claim, event log, run state
 *
 * A bare repository is created on local disk and used as the origin, so this
 * exercises the identical mirror-then-clone path production takes without
 * touching github.com. The model provider is `FakeUpstream`, so there is no API
 * key and no egress -- which is exactly the property that moving the model call
 * to the host bought us.
 *
 * Skips cleanly, with a reason, when Docker or Postgres is absent. Every test
 * carries an explicit timeout: a run loop that stalls must fail the suite, not
 * hang it.
 */

const TEST_TIMEOUT_MS = 240_000;
const FAKE_KEY = "sk-test-not-a-real-key-000000000000";

const skip = (await dockerUnavailable()) || (await postgresUnavailable());

describe(
  "the vertical slice: queue -> container -> event log -> derived diff -> pushed branch",
  { skip: skip === false ? undefined : skip },
  () => {
  let docker: Docker;
  let db: Database;
  let closeDb: () => Promise<unknown>;
  let sandbox: DockerSandbox;
  let hostDir: string;
  let dataDir: string;
  let originPath: string;
  let baseSha: string;
  let lock: DockerTestLock;

  const repoIds: string[] = [];
  const taskIds: string[] = [];
  const volumes = new Set<string>();
  const gateways = new Set<GatewayServer>();

  before(async () => {
    // Two suites driving Docker Desktop at once wedge its socket forwarder.
    lock = await acquireDockerTestLock();
    docker = new Docker({ socketPath: TEST_DOCKER_SOCKET });
    ({ db, close: closeDb } = createDb(TEST_DATABASE_URL));
    await withTimeout(db.execute("select 1"), 10_000, "connecting to Postgres");

    // Under $HOME: Docker Desktop's file-sharing allowlist covers /Users but
    // not /private/var/folders, and the gateway socket has to be bind-mountable.
    hostDir = await realpath(await mkdtemp(join(homedir(), ".codexclone-m5-")));
    dataDir = join(hostDir, "data");
    await mkdir(join(hostDir, "gw"), { recursive: true, mode: 0o700 });
    await mkdir(join(dataDir, "jobs"), { recursive: true, mode: 0o700 });
    sandbox = new DockerSandbox({ socketPath: TEST_DOCKER_SOCKET, jobSpecDir: join(dataDir, "jobs") });

    ({ originPath, baseSha } = await createOriginRepo(join(hostDir, "origin")));
  });

  after(async () => {
    for (const gateway of gateways) await gateway.close().catch(() => undefined);
    for (const volume of volumes) await removeVolume(docker, volume, { force: true }).catch(() => undefined);
    if (db) {
      for (const taskId of taskIds) {
        // events and runs cascade from tasks; repos do not.
        await db.delete(tasks).where(eq(tasks.id, taskId)).catch(() => undefined);
      }
      for (const repoId of repoIds) await db.delete(repos).where(eq(repos.id, repoId)).catch(() => undefined);
    }
    await closeDb?.().catch(() => undefined);
    if (hostDir) await rm(hostDir, { recursive: true, force: true }).catch(() => undefined);
    await lock?.release().catch(() => undefined);
  });

  /** A real git repository on local disk, standing in for github.com. */
  async function createOriginRepo(root: string): Promise<{ originPath: string; baseSha: string }> {
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
    return { originPath: bare, baseSha: sha };
  }

  /** Rows the web app's POST /api/tasks would have written. */
  async function seedTask(prompt: string): Promise<{ taskId: string; runId: string; repoId: string }> {
    const suffix = randomUUID().slice(0, 8);
    const repoId = `repo-m5-${suffix}`;
    const taskId = `task-m5-${suffix}`;
    const runId = `run-m5-${suffix}`;

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

  function makeDeps(turns: ConstructorParameters<typeof FakeUpstream>[0]): {
    deps: SupervisorDeps;
    gateway: GatewayServer;
    fake: FakeUpstream;
  } {
    const fake = new FakeUpstream(turns);
    const socketPath = join(hostDir, "gw", `${randomUUID().slice(0, 8)}.sock`);
    const gateway = new GatewayServer({
      socketPath,
      credentials: new StaticCredentialStore(FAKE_KEY),
      upstream: fake,
      budget: { maxTurns: 10, maxCostUsd: 100, wallClockMs: 180_000 },
    });
    gateways.add(gateway);

    const deps: SupervisorDeps = {
      db,
      docker,
      sandboxes: sandbox,
      mirrors: new MirrorManager({ dataDir }),
      meters: gateway.meters,
      githubToken: () => Promise.resolve(null),
      model: () => Promise.resolve("gpt-5-mini"),
      // The fixture repo lives on disk, so the mirror clones from a path.
      cloneUrl: () => originPath,
      config: {
        image: TEST_IMAGE,
        gatewaySocketPath: socketPath,
        limits: { ...DEFAULT_LIMITS, memoryMb: 768, cpus: 1, pids: 128 },
        stopGraceMs: 5_000,
        dataDir,
      },
    };
    return { deps, gateway, fake };
  }

  /**
   * Claims until OUR run comes up, then puts anything else it picked up back.
   *
   * The queue is global and a developer's database may already hold queued runs
   * from real use; the test must not depend on being alone, and must not
   * swallow someone else's work either.
   *
   * It CAN still come back empty-handed, and there is exactly one way that
   * happens: a real worker is running against the same database and claimed the
   * run first. That is a true statement about the environment rather than a bug
   * in the queue, so the assertion below says so.
   */
  async function claimSpecific(runId: string) {
    const parked: Array<{ runId: string; taskId: string }> = [];
    let mine: Awaited<ReturnType<typeof claimNextRun>> = null;
    for (let attempt = 0; attempt < 25 && !mine; attempt += 1) {
      const claimed = await claimNextRun(db, "int-test-worker");
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

  it(
    "claims a queued run, seeds the workspace, and streams a real agent turn into the event log",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { taskId, runId } = await seedTask("add a CONTRIBUTING file");
      const { deps, gateway, fake } = makeDeps([
        [
          upstream.toolCall("call_1", "apply_patch", {
            patch: "*** Begin Patch\n*** Add File: CONTRIBUTING.md\n+Run the tests with `npm test`.\n*** End Patch\n",
          }),
          upstream.done(1200, 80, 300),
        ],
        [upstream.delta("m1", "Added CONTRIBUTING.md."), upstream.done(400, 30)],
      ]);
      await gateway.listen();

      // The claim itself is the queue: FOR UPDATE SKIP LOCKED inside a
      // transaction, exactly as a second worker would run it.
      const claimed = await claimSpecific(runId);
      assert.ok(
        claimed,
        `run ${runId} was never claimable -- is a worker already running against ${TEST_DATABASE_URL}? ` +
          `Stop \`pnpm dev\` before running the suite; two workers share one queue by design.`,
      );
      assert.equal(claimed.runId, runId);

      const outcome = await withTimeout(superviseRun(deps, claimed), TEST_TIMEOUT_MS - 10_000, "the run loop");
      assert.equal(outcome.status, "succeeded", `run failed: ${outcome.stopReason ?? "(no reason)"}`);

      const rows = await readEvents(db, taskId);
      const types = rows.map((r) => r.type);
      assert.ok(types.includes("setup_log"), "the host's workspace preparation should be in the transcript");
      assert.ok(types.includes("tool_call"));
      assert.ok(types.includes("tool_result"));
      assert.ok(types.includes("message"));

      // The host wrote the first line before any container existed.
      assert.equal(rows[0]?.type, "status");
      assert.deepEqual(rows[0]?.payload, { status: "running" });

      // seq is strictly increasing across host and agent events alike.
      const seqs = rows.map((r) => r.seq);
      assert.deepEqual([...seqs].sort((a, b) => a - b), seqs);
      assert.equal(new Set(seqs).size, seqs.length, "seq must be unique within a task");

      const toolResult = rows.find((r) => r.type === "tool_result");
      assert.equal((toolResult?.payload as { ok: boolean }).ok, true);

      /**
       * The diff is DERIVED. Nothing in the scripted turns above told the host
       * what changed -- it extracted the volume and ran `git diff` against the
       * pinned SHA, so this is the workspace's own account of itself.
       */
      const diff = rows.find((r) => r.type === "diff");
      assert.ok(diff, `expected a derived diff; saw ${types.join(", ")}`);
      const payload = diff.payload as {
        baseSha: string;
        files: Array<{ path: string; status: string; additions: number; deletions: number }>;
        patch: string;
        truncated: boolean;
      };
      assert.equal(payload.baseSha, baseSha, "the diff is measured against the pin, not against HEAD");
      assert.deepEqual(payload.files, [
        { path: "CONTRIBUTING.md", status: "added", additions: 1, deletions: 0 },
      ]);
      assert.match(payload.patch, /^diff --git a\/CONTRIBUTING\.md/m);
      assert.match(payload.patch, /\+Run the tests with/);
      assert.equal(payload.truncated, false);

      // It sits in the gap reserved for the host, between the tool result that
      // made the change and the message that ended the turn.
      const resultSeq = toolResult?.seq ?? 0;
      const messageSeq = rows.find((r) => r.type === "message")?.seq ?? 0;
      assert.ok(diff.seq > resultSeq && diff.seq < messageSeq, `diff at ${diff.seq} should sit in (${resultSeq}, ${messageSeq})`);

      // Exactly one: a turn that wrote three times still produces one diff.
      assert.equal(rows.filter((r) => r.type === "diff").length, 1);

      // Deltas are ephemeral: nothing of the kind reaches the durable log.
      assert.equal(types.includes("delta" as never), false);
      // ...and the key the host attached is nowhere in it either.
      assert.equal(JSON.stringify(rows).includes(FAKE_KEY), false);
      assert.equal(fake.lastApiKey, FAKE_KEY);

      // The run row carries the metered cost, and the task is idle again.
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));
      assert.equal(run?.status, "succeeded");
      assert.equal(run?.phase, "done");
      assert.equal(run?.inputTokens, 1600);
      assert.equal(run?.cachedInputTokens, 300);
      assert.equal(run?.outputTokens, 110);
      assert.ok((run?.costUsd ?? 0) > 0, "cost should have been recorded by the gateway meter");
      assert.ok(run?.endedAt, "endedAt must be set so the run does not look in-flight");

      const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      assert.equal(task?.status, "idle");
      assert.equal(task?.volumeName, workspaceVolumeName(taskId));
      assert.ok(task?.workBranch?.startsWith("codex/"));

      // The file the agent wrote is really in the volume, on the work branch,
      // and the container is gone while the volume survives it.
      const listing = await runInVolume(docker, workspaceVolumeName(taskId), "cat /workspace/CONTRIBUTING.md");
      assert.match(listing, /Run the tests with/);

      const branch = await runInVolume(
        docker,
        workspaceVolumeName(taskId),
        "git -C /workspace -c safe.directory=/workspace rev-parse --abbrev-ref HEAD",
      );
      assert.match(branch, /^codex\//);

      /**
       * Publishing, against the same fixture origin. No model is involved --
       * the work already exists in the volume -- so this exercises the real
       * commit-and-push path for free.
       */
      const publishDeps = {
        db,
        docker,
        githubToken: () => Promise.resolve(null),
        config: { image: TEST_IMAGE, dataDir },
        remoteUrl: () => originPath,
      };

      const first = await withTimeout(publishTask(publishDeps, taskId), 120_000, "the first push");
      assert.equal(first.filesChanged, 1);
      assert.ok(first.commit);
      assert.equal(first.pullRequest, null, "no pull request was asked for");

      // The branch is really on the origin, and it really carries the file.
      const remoteSha = (await git(["--git-dir", originPath, "rev-parse", `refs/heads/${first.branch}`])).trim();
      assert.equal(remoteSha, first.commit);
      const remoteTree = await git(["--git-dir", originPath, "ls-tree", "--name-only", remoteSha]);
      assert.ok(remoteTree.split("\n").includes("CONTRIBUTING.md"), `origin tree: ${remoteTree}`);

      /**
       * The commit was made in an EXTRACTED COPY, so unless `.git` was written
       * back into the volume the workspace would still believe it was sitting
       * at the base commit -- and this second push would build a different
       * commit from the same parent and diverge from the branch already on the
       * origin.
       *
       * Getting the identical SHA back is therefore the assertion that the
       * write-back worked: nothing else could produce it.
       */
      const second = await withTimeout(publishTask(publishDeps, taskId), 120_000, "the second push");
      assert.equal(second.filesChanged, 0, "there was nothing new to commit");
      assert.equal(second.commit, first.commit, "the volume must have kept the commit; otherwise this diverges");

      const unchanged = (await git(["--git-dir", originPath, "rev-parse", `refs/heads/${first.branch}`])).trim();
      assert.equal(unchanged, remoteSha, "the origin must not have moved");

      // And a task that has never run cannot be published at all.
      const bare = await seedTask("never run");
      await assert.rejects(
        () => publishTask(publishDeps, bare.taskId),
        (error: unknown) => error instanceof PublishError && /no workspace yet/.test((error as Error).message),
      );
    },
  );

  it(
    "re-ingesting the same events is a no-op, so a worker restart cannot duplicate a transcript",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { taskId, runId } = await seedTask("idempotency check");
      assert.equal((await readEvents(db, taskId)).length, 0);

      const row = {
        seq: 64,
        runId,
        taskId,
        type: "reasoning" as const,
        payload: { text: "thinking" },
        createdAt: new Date().toISOString(),
      };

      assert.equal(await appendEvent(db, row), true, "the first write should land");
      assert.equal(await appendEvent(db, row), false, "the replay should be dropped by the unique index");
      assert.equal(
        await appendEvent(db, { ...row, payload: { text: "a different account of the same seq" } }),
        false,
        "the first write wins; a replay must not rewrite history",
      );

      const stored = await db.select().from(events).where(eq(events.taskId, taskId));
      assert.equal(stored.length, 1);
      assert.deepEqual(stored[0]?.payload, { text: "thinking" });

      // And the shape round-trips: an ISO string in, an ISO string out.
      const [readBack] = await readEvents(db, taskId);
      assert.equal(readBack?.createdAt, row.createdAt);
    },
  );

  it(
    "a second worker cannot claim the same run",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { runId } = await seedTask("claim contention");
      const first = await claimSpecific(runId);
      assert.ok(first);
      // The row is now `running`, so no other worker's claim can see it -- and
      // the task-level guard keeps a follow-up from racing it either.
      const second = await claimNextRun(db, "worker-b");
      assert.notEqual(second?.runId, first.runId);
      if (second) {
        await db.update(runs).set({ status: "queued", claimedBy: null, startedAt: null }).where(eq(runs.id, second.runId));
        await db.update(tasks).set({ status: "queued" }).where(eq(tasks.id, second.taskId));
      }

      await db.update(runs).set({ status: "failed", endedAt: new Date() }).where(eq(runs.id, first.runId));
      await db.update(tasks).set({ status: "idle" }).where(eq(tasks.id, first.taskId));
    },
  );
});

/**
 * Runs one command against a task's workspace volume, as the agent's uid.
 *
 * Used to check what is REALLY on disk rather than what the transcript claims
 * is on disk -- the same principle the derived diff rests on.
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
    await withTimeout(container.wait(), 60_000, `command in volume ${volumeName}`);
    const logs = (await container.logs({ stdout: true, stderr: true })) as unknown as Buffer;
    // Non-TTY container logs are frame-multiplexed; unpack with the same
    // demuxer the provider uses rather than stripping bytes by hand.
    let out = "";
    for (const frame of new FrameDemuxer().push(Buffer.from(logs))) out += frame.data.toString("utf8");
    return out;
  } finally {
    await container.remove({ force: true, v: false }).catch(() => undefined);
  }
}
