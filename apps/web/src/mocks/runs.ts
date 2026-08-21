/**
 * Four fixture runs: one that works, and three unhappy paths. The unhappy ones
 * matter more than the happy one — a transcript UI that only renders success is
 * exactly the UI that fails the first time a container dies.
 */

import type { AnyEventRow, RunStatus } from "@codex-clone/core";
import { RunBuilder, type PlaybackFrame } from "./builder";

export interface MockRun {
  id: string;
  taskId: string;
  label: string;
  /** Why this fixture exists — shown on the mock playback page. */
  blurb: string;
  status: RunStatus;
  prompt: string;
  events: AnyEventRow[];
  frames: PlaybackFrame[];
}

const RATE_LIMIT_PATCH = `diff --git a/src/middleware/rateLimit.ts b/src/middleware/rateLimit.ts
new file mode 100644
index 0000000..7c1f9ab
--- /dev/null
+++ b/src/middleware/rateLimit.ts
@@ -0,0 +1,46 @@
+import type { NextFunction, Request, Response } from "express";
+import { redis } from "../lib/redis";
+
+export interface RateLimitOptions {
+  windowMs: number;
+  max: number;
+  keyFor?: (req: Request) => string;
+}
+
+const DEFAULT_KEY = (req: Request) => req.ip ?? "anonymous";
+
+/**
+ * Fixed-window limiter backed by Redis. A sliding window would be kinder to
+ * bursty clients, but it needs a sorted set per key; fixed windows keep the
+ * hot path to a single INCR and are what the SLO actually calls for.
+ */
+export function rateLimit(options: RateLimitOptions) {
+  const keyFor = options.keyFor ?? DEFAULT_KEY;
+
+  return async function rateLimitMiddleware(
+    req: Request,
+    res: Response,
+    next: NextFunction,
+  ): Promise<void> {
+    const window = Math.floor(Date.now() / options.windowMs);
+    const key = "rl:" + keyFor(req) + ":" + window;
+
+    const hits = await redis.incr(key);
+    if (hits === 1) {
+      await redis.pexpire(key, options.windowMs);
+    }
+
+    const remaining = Math.max(0, options.max - hits);
+    res.setHeader("RateLimit-Limit", String(options.max));
+    res.setHeader("RateLimit-Remaining", String(remaining));
+
+    if (hits > options.max) {
+      const ttl = await redis.pttl(key);
+      res.setHeader("Retry-After", String(Math.ceil(ttl / 1000)));
+      res.status(429).json({ error: "rate_limited", retryAfterMs: ttl });
+      return;
+    }
+
+    next();
+  };
+}
diff --git a/src/server.ts b/src/server.ts
index 3a91c02..b8d4e17 100644
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,15 +1,20 @@
 import express from "express";
 import { router as publicRouter } from "./routes/public";
+import { rateLimit } from "./middleware/rateLimit";

 export function createServer() {
   const app = express();

   app.use(express.json({ limit: "1mb" }));
-  app.use("/v1", publicRouter);
+  app.use(
+    "/v1",
+    rateLimit({ windowMs: 60_000, max: 120 }),
+    publicRouter,
+  );

   app.get("/healthz", (_req, res) => {
     res.status(200).send("ok");
   });

   return app;
 }
diff --git a/src/middleware/rateLimit.test.ts b/src/middleware/rateLimit.test.ts
new file mode 100644
index 0000000..2ad77e1
--- /dev/null
+++ b/src/middleware/rateLimit.test.ts
@@ -0,0 +1,22 @@
+import assert from "node:assert/strict";
+import { test } from "node:test";
+import { rateLimit } from "./rateLimit";
+import { fakeRedis } from "../test/fakeRedis";
+
+test("allows requests under the limit", async () => {
+  const mw = rateLimit({ windowMs: 1000, max: 2 });
+  const res = fakeRedis.res();
+  let called = 0;
+  await mw(fakeRedis.req(), res, () => { called += 1; });
+  assert.equal(called, 1);
+  assert.equal(res.headers["RateLimit-Remaining"], "1");
+});
+
+test("rejects the request past the limit with Retry-After", async () => {
+  const mw = rateLimit({ windowMs: 1000, max: 1 });
+  const res = fakeRedis.res();
+  await mw(fakeRedis.req(), res, () => {});
+  await mw(fakeRedis.req(), res, () => {});
+  assert.equal(res.statusCode, 429);
+  assert.ok(res.headers["Retry-After"]);
+});
`;

const README_PATCH = `diff --git a/README.md b/README.md
index 91c0aa1..dd3e440 100644
--- a/README.md
+++ b/README.md
@@ -14,6 +14,8 @@ pnpm dev

 ## Configuration

+Rate limiting is applied to every \`/v1\` route: 120 requests per minute per IP.
+Override with \`RATE_LIMIT_MAX\` and \`RATE_LIMIT_WINDOW_MS\`.

 | Variable | Default |
 |---|---|
`;

/* -------------------------------------------------------------------------- */
/* 1. The happy path                                                           */
/* -------------------------------------------------------------------------- */

function buildSucceeded(): MockRun {
  const b = new RunBuilder("run_8f21c4", "task_rate_limit", "2026-08-19T09:14:02.000Z");

  b.event("phase", { phase: "setup" }, 200);
  b.setup([
    ["stdout", "$ pnpm install --frozen-lockfile"],
    ["stdout", "Lockfile is up to date, resolution step is skipped"],
    ["stdout", "Packages: +312"],
    ["stdout", "++++++++++++++++++++++++++++++++++++++++++++++++++++++++"],
    ["stdout", "Progress: resolved 312, reused 312, downloaded 0, added 312, done"],
    ["stderr", "warn  deprecated inflight@1.0.6: This module is not supported"],
    ["stdout", ""],
    ["stdout", "dependencies:"],
    ["stdout", "+ express 4.21.2"],
    ["stdout", "+ ioredis 5.4.1"],
    ["stdout", ""],
    ["stdout", "Done in 4.1s"],
  ]);
  b.event("phase", { phase: "agent" }, 300);

  b.event(
    "reasoning",
    {
      text:
        "The task asks for rate limiting on the public API. Before writing anything I " +
        "want to know whether there is already a limiter, what the router looks like, " +
        "and whether Redis is available in this service — a per-process in-memory " +
        "counter would silently do nothing once this deploys to more than one pod.",
    },
    900,
  );

  b.say(
    "msg_01",
    "assistant",
    "Starting by mapping what already exists — I want to avoid adding a second " +
      "limiter next to one I did not notice.",
  );

  b.tool(
    "call_grep_1",
    "grep",
    { pattern: "rate.?limit|429|Retry-After", path: "src", ignoreCase: true },
    {
      ok: true,
      output:
        "src/routes/public.ts:44:  // TODO: rate limit this endpoint before launch\n" +
        "src/lib/redis.ts:1:import Redis from \"ioredis\";\n" +
        "docs/slo.md:22:| Public API | 120 req/min/IP | 429 with Retry-After |",
      truncated: false,
      exitCode: 0,
      durationMs: 214,
    },
  );

  b.tool(
    "call_read_1",
    "read_file",
    { path: "src/server.ts" },
    {
      ok: true,
      output:
        "import express from \"express\";\n" +
        "import { router as publicRouter } from \"./routes/public\";\n" +
        "\n" +
        "export function createServer() {\n" +
        "  const app = express();\n" +
        "\n" +
        "  app.use(express.json({ limit: \"1mb\" }));\n" +
        "  app.use(\"/v1\", publicRouter);\n" +
        "\n" +
        "  app.get(\"/healthz\", (_req, res) => {\n" +
        "    res.status(200).send(\"ok\");\n" +
        "  });\n" +
        "\n" +
        "  return app;\n" +
        "}",
      truncated: false,
      exitCode: 0,
      durationMs: 61,
    },
  );

  b.event(
    "reasoning",
    {
      text:
        "docs/slo.md already commits to 120 req/min/IP with a 429 and a Retry-After " +
        "header, so the numbers are decided for me. ioredis is already a dependency, " +
        "so the counter can be shared across processes. Fixed window over sliding " +
        "window: one INCR on the hot path, and the SLO is expressed as a fixed window " +
        "anyway.",
    },
    1100,
  );

  b.tool(
    "call_patch_1",
    "apply_patch",
    {
      path: "src/middleware/rateLimit.ts",
      summary: "Add Redis-backed fixed-window rate limit middleware",
    },
    { ok: true, output: "Created src/middleware/rateLimit.ts (44 lines)", truncated: false, exitCode: 0, durationMs: 88 },
  );

  b.tool(
    "call_patch_2",
    "apply_patch",
    { path: "src/server.ts", summary: "Mount the limiter in front of the /v1 router" },
    { ok: true, output: "Updated src/server.ts (+8 -1)", truncated: false, exitCode: 0, durationMs: 74 },
  );

  b.tool(
    "call_patch_3",
    "apply_patch",
    { path: "src/middleware/rateLimit.test.ts", summary: "Cover the under-limit and over-limit paths" },
    { ok: true, output: "Created src/middleware/rateLimit.test.ts (31 lines)", truncated: false, exitCode: 0, durationMs: 69 },
  );

  b.tool(
    "call_shell_1",
    "shell",
    { command: "pnpm test -- src/middleware", cwd: "/workspace" },
    {
      ok: true,
      output:
        "> atlas-api@2.4.0 test /workspace\n" +
        "> node --import tsx --test src/middleware/**/*.test.ts\n" +
        "\n" +
        "✓ allows requests under the limit (3.114ms)\n" +
        "✓ rejects the request past the limit with Retry-After (1.902ms)\n" +
        "\n" +
        "# tests 2\n" +
        "# pass 2\n" +
        "# fail 0",
      truncated: false,
      exitCode: 0,
      durationMs: 6210,
    },
  );

  b.event(
    "diff",
    {
      baseSha: "a41f0c9d3b6e2f7148ac55d90b2e1c8f4a7d3e12",
      files: [
        { path: "src/middleware/rateLimit.ts", additions: 46, deletions: 0, status: "added" },
        { path: "src/server.ts", additions: 6, deletions: 1, status: "modified" },
        { path: "src/middleware/rateLimit.test.ts", additions: 22, deletions: 0, status: "added" },
      ],
      patch: RATE_LIMIT_PATCH,
      truncated: false,
    },
    700,
  );

  b.say(
    "msg_02",
    "assistant",
    "Done. `/v1` now goes through a Redis-backed fixed-window limiter at 120 req/min " +
      "per IP, matching the number already written down in docs/slo.md. Over-limit " +
      "requests get a 429 with Retry-After; every response carries RateLimit-Limit and " +
      "RateLimit-Remaining. Two tests cover both sides of the boundary and pass.\n\n" +
      "One thing to decide: the key is req.ip, which behind a load balancer is the " +
      "balancer unless trust proxy is set. Worth confirming before this ships.",
    { chunk: 16, gapMs: 22 },
  );

  b.event("phase", { phase: "finalizing" }, 240);
  b.event("status", { status: "succeeded", reason: "Agent finished in 6 turns" }, 300);
  b.event("phase", { phase: "done" }, 120);

  return {
    id: b.runId,
    taskId: b.taskId,
    label: "Succeeded",
    blurb: "Setup, reasoning, four tool calls, a derived diff, and a clean finish.",
    status: "succeeded",
    prompt: "Add rate limiting to the public API and cover it with tests.",
    events: b.events,
    frames: b.frames,
  };
}

/* -------------------------------------------------------------------------- */
/* 2. Cancelled mid-turn                                                       */
/* -------------------------------------------------------------------------- */

function buildCancelled(): MockRun {
  const b = new RunBuilder("run_c30a17", "task_migrate_orm", "2026-08-19T14:02:11.000Z");

  b.event("phase", { phase: "setup" }, 200);
  b.setup([
    ["stdout", "$ uv sync --frozen"],
    ["stdout", "Resolved 84 packages in 212ms"],
    ["stdout", "Installed 84 packages in 1.31s"],
    ["stdout", "Done in 1.6s"],
  ]);
  b.event("phase", { phase: "agent" }, 260);

  b.event(
    "reasoning",
    {
      text:
        "Migrating 31 models from SQLAlchemy declarative to the 2.0 typed style. I will " +
        "start with the smallest module to establish the pattern, then fan out.",
    },
    800,
  );

  b.say(
    "msg_01",
    "assistant",
    "There are 31 models across 9 modules. I will convert `app/models/billing.py` " +
      "first to settle the pattern, then apply it to the rest.",
  );

  b.tool(
    "call_shell_1",
    "shell",
    { command: "rg -c 'declarative_base|Column\\\\(' app/models", cwd: "/workspace" },
    {
      ok: true,
      output:
        "app/models/billing.py:14\napp/models/account.py:22\napp/models/usage.py:19\n" +
        "app/models/invoice.py:27\napp/models/webhook.py:8",
      truncated: false,
      exitCode: 0,
      durationMs: 143,
    },
  );

  b.tool(
    "call_patch_1",
    "apply_patch",
    { path: "app/models/billing.py", summary: "Convert to Mapped[] / mapped_column()" },
    { ok: true, output: "Updated app/models/billing.py (+41 -38)", truncated: false, exitCode: 0, durationMs: 121 },
  );

  b.tool(
    "call_shell_2",
    "shell",
    { command: "uv run pytest tests/models -x -q", cwd: "/workspace" },
    {
      ok: false,
      output:
        "============================= test session starts ==============================\n" +
        "collected 118 items\n\n" +
        "tests/models/test_billing.py ...........F\n\n" +
        "=================================== FAILURES ===================================\n" +
        "________________ test_invoice_line_items_cascade_on_delete _____________________\n" +
        "sqlalchemy.exc.ArgumentError: relationship 'line_items' expects a class or\n" +
        "mapper argument (received: <class 'str'>)\n" +
        "[... 214 lines truncated ...]",
      truncated: true,
      exitCode: 1,
      durationMs: 18400,
    },
  );

  // The user hit Cancel here. The cancel rides the same socket as the events
  // (PLAN.md §3.6) and the run winds down; partial work survives in the volume.
  b.event(
    "status",
    {
      status: "cancelled",
      reason: "Cancelled from the UI. SIGTERM sent, container exited within the 10s grace period.",
    },
    2600,
  );
  b.event("phase", { phase: "done" }, 140);

  return {
    id: b.runId,
    taskId: b.taskId,
    label: "Cancelled",
    blurb: "Stopped mid-turn from the UI. Note the truncated tool output and the stop reason.",
    status: "cancelled",
    prompt: "Migrate all SQLAlchemy models to the 2.0 typed style.",
    events: b.events,
    frames: b.frames,
  };
}

/* -------------------------------------------------------------------------- */
/* 3. Budget exhausted                                                         */
/* -------------------------------------------------------------------------- */

function buildBudgetExhausted(): MockRun {
  const b = new RunBuilder("run_bd7e02", "task_flaky_suite", "2026-08-18T21:40:55.000Z");

  b.event("phase", { phase: "setup" }, 180);
  b.setup([
    ["stdout", "$ npm ci"],
    ["stdout", "added 1842 packages, and audited 1843 packages in 22s"],
    ["stdout", "found 0 vulnerabilities"],
  ]);
  b.event("phase", { phase: "agent" }, 240);

  b.event(
    "reasoning",
    {
      text:
        "The suite fails intermittently, which usually means shared state or a real " +
        "clock. Running it repeatedly to find a reproducer is the obvious move, but it " +
        "is also expensive — each full run is roughly 90 seconds.",
    },
    900,
  );

  b.tool(
    "call_shell_1",
    "shell",
    { command: "npx vitest run --reporter=verbose --repeat=5", cwd: "/workspace" },
    {
      ok: false,
      output:
        "FAIL  src/queue/scheduler.test.ts > drains due jobs exactly once\n" +
        "AssertionError: expected 3 to be 2\n" +
        " ❯ src/queue/scheduler.test.ts:88:24\n" +
        "\n Test Files  1 failed | 42 passed (43)\n" +
        "      Tests  1 failed | 611 passed (612)\n" +
        "[... 1,908 lines truncated ...]",
      truncated: true,
      exitCode: 1,
      durationMs: 94120,
    },
  );

  b.say(
    "msg_01",
    "assistant",
    "Reproduced on the third repeat: `scheduler.test.ts` drains a job twice when two " +
      "tests share the module-level timer. Narrowing it down.",
  );

  b.tool(
    "call_read_1",
    "read_file",
    { path: "src/queue/scheduler.ts", startLine: 1, endLine: 120 },
    {
      ok: true,
      output: "let timer: NodeJS.Timeout | null = null;\n\nexport function start() {\n  if (timer) return;\n  timer = setInterval(tick, 1000);\n}\n[... 108 lines elided ...]",
      truncated: true,
      exitCode: 0,
      durationMs: 52,
    },
  );

  b.tool(
    "call_shell_2",
    "shell",
    { command: "npx vitest run src/queue --repeat=20", cwd: "/workspace" },
    {
      ok: false,
      output: "Test Files  1 failed | 3 passed (4)\n     Tests  2 failed | 47 passed (49)\n[... 3,410 lines truncated ...]",
      truncated: true,
      exitCode: 1,
      durationMs: 121400,
    },
  );

  b.event(
    "error",
    {
      code: "gateway_refused:max_cost",
      message:
        "Cost budget of $1.00 reached (spent $1.02 over 27 turns). Injecting a wind-down " +
        "instruction; the agent gets one final turn to summarise.",
      retryable: false,
    },
    600,
  );

  b.say(
    "msg_02",
    "assistant",
    "Winding down as instructed. What I established: the flake is module-level timer " +
      "state in `src/queue/scheduler.ts` — `timer` is a module singleton, so a test " +
      "that calls `start()` without a matching `stop()` leaves an interval running into " +
      "the next test, and the next `tick` drains a job the second suite also claims.\n\n" +
      "The fix I did not get to: make the scheduler an instance rather than a module " +
      "singleton, or add an `afterEach(stop)` in `src/queue/setup.ts`. The second is a " +
      "one-line change and would confirm the diagnosis cheaply.",
    { chunk: 18, gapMs: 20 },
  );

  b.event("phase", { phase: "finalizing" }, 300);
  b.event(
    "status",
    {
      status: "budget_exhausted",
      reason: "the cost ceiling was reached after 27 turns and $1.0210",
    },
    400,
  );
  b.event("phase", { phase: "done" }, 120);

  return {
    id: b.runId,
    taskId: b.taskId,
    label: "Budget exhausted",
    blurb: "Hit the cost ceiling, got its graceful wind-down turn, and stopped with a reason.",
    status: "budget_exhausted",
    prompt: "Find and fix the flaky test in the queue suite.",
    events: b.events,
    frames: b.frames,
  };
}

/* -------------------------------------------------------------------------- */
/* 3b. Timed out — the wall clock, which is NOT the same as running out of     */
/*     budget: no wind-down turn, because the agent never asked for one.        */
/* -------------------------------------------------------------------------- */

function buildTimedOut(): MockRun {
  const b = new RunBuilder("run_7c9d41", "task_slow_build", "2026-08-19T17:22:08.000Z");

  b.event("phase", { phase: "setup" }, 200);
  b.setup([
    ["stdout", "$ ./gradlew --no-daemon assemble"],
    ["stdout", "Starting a Gradle Daemon (subsequent builds will be faster)"],
    ["stdout", "BUILD SUCCESSFUL in 3m 41s"],
  ]);
  b.event("phase", { phase: "agent" }, 260);

  b.event(
    "reasoning",
    {
      text:
        "The integration suite is the only thing that exercises the code path in " +
        "question, so I will run it once before changing anything. It is slow, but a " +
        "change I cannot verify is worse than a slow verification.",
    },
    800,
  );

  b.say(
    "msg_01",
    "assistant",
    "Running the integration suite first so I have a baseline to compare against.",
  );

  /**
   * The whole point of this fixture: one tool call that never returns. The
   * gateway meter checks the wall clock only when a model call arrives, and no
   * further call ever arrives -- so the host's own deadline is what stops this,
   * and there is no polite wind-down turn to show.
   */
  b.tool(
    "call_shell_1",
    "shell",
    { command: "./gradlew integrationTest --no-daemon", cwd: "/workspace" },
    {
      ok: false,
      output:
        "> Task :integration:test\n" +
        "PaymentReconciliationIT > settlesAcrossTimezones STANDARD_OUT\n" +
        "    waiting for the embedded broker to come up...\n" +
        "[... no further output for 16 minutes ...]",
      truncated: true,
      durationMs: 986_000,
    },
  );

  b.event(
    "error",
    {
      code: "gateway_refused:wall_clock",
      message: "the wall-clock limit of 20m was reached; the sandbox was stopped",
      retryable: false,
    },
    500,
  );
  b.event(
    "status",
    { status: "timed_out", reason: "the wall-clock limit of 20m was reached; the sandbox was stopped" },
    300,
  );
  b.event("phase", { phase: "done" }, 120);

  return {
    id: b.runId,
    taskId: b.taskId,
    label: "Timed out",
    blurb:
      "Wedged inside one tool call, so the gateway meter never fired. The host's wall-clock deadline stopped it — " +
      "and it reads as timed_out, not as a budget breach.",
    status: "timed_out",
    prompt: "Make the payment reconciliation job timezone-safe.",
    events: b.events,
    frames: b.frames,
  };
}

/* -------------------------------------------------------------------------- */
/* 4. Setup failed — never reached the agent phase                             */
/* -------------------------------------------------------------------------- */

function buildSetupFailed(): MockRun {
  const b = new RunBuilder("run_51ba9e", "task_bump_node", "2026-08-18T08:03:44.000Z");

  b.event("phase", { phase: "setup" }, 180);
  b.setup(
    [
      ["stdout", "$ pnpm install --frozen-lockfile"],
      ["stdout", "Scope: all 6 workspace projects"],
      ["stderr", " ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\" because pnpm-lock.yaml is not up to date with packages/api/package.json"],
      ["stderr", ""],
      ["stderr", "Note that in CI environments this setting is true by default."],
      ["stderr", "If you still need to run install in such cases, use \"pnpm install --no-frozen-lockfile\""],
      ["stderr", ""],
      ["stderr", "Failure reason:"],
      ["stderr", "specifiers in the lockfile don't match specifiers in package.json:"],
      ["stderr", "* 3 dependencies were added: undici@^7.2.0, zod@^3.24.1, pino@^9.6.0"],
      ["stdout", ""],
      ["stdout", "setup script exited with code 1"],
    ],
    150,
  );

  b.event(
    "error",
    {
      code: "setup_failed",
      message:
        "Repo setup script exited 1. The agent phase was never entered, so no model " +
        "tokens were spent. Fix the lockfile or change the setup script in Settings.",
      retryable: true,
    },
    400,
  );
  b.event(
    "status",
    { status: "failed", reason: "setup script `pnpm install --frozen-lockfile` exited 1" },
    260,
  );
  b.event("phase", { phase: "done" }, 120);

  return {
    id: b.runId,
    taskId: b.taskId,
    label: "Setup failed",
    blurb: "The install step died. A failing install is its own visible phase, not a mystery hang.",
    status: "failed",
    prompt: "Bump the repo to Node 22 and update the CI matrix.",
    events: b.events,
    frames: b.frames,
  };
}

/* -------------------------------------------------------------------------- */
/* 5. A follow-up turn on the succeeded task — a second run, same task          */
/* -------------------------------------------------------------------------- */

function buildFollowUp(): MockRun {
  const b = new RunBuilder("run_8f21c5", "task_rate_limit", "2026-08-19T09:31:40.000Z");

  b.event("phase", { phase: "agent" }, 200);
  b.say("msg_00", "user", "Key on the X-Forwarded-For header when trust proxy is on.", { chunk: 200 });
  b.event(
    "reasoning",
    { text: "Reusing the warm container — the workspace volume still holds the previous turn's edits, so no clone and no setup phase." },
    700,
  );
  b.tool(
    "call_patch_9",
    "apply_patch",
    { path: "src/middleware/rateLimit.ts", summary: "Honour trust proxy when deriving the key" },
    { ok: true, output: "Updated src/middleware/rateLimit.ts (+9 -2)", truncated: false, exitCode: 0, durationMs: 96 },
  );
  b.event(
    "diff",
    {
      baseSha: "a41f0c9d3b6e2f7148ac55d90b2e1c8f4a7d3e12",
      files: [
        { path: "src/middleware/rateLimit.ts", additions: 53, deletions: 2, status: "modified" },
        { path: "src/server.ts", additions: 6, deletions: 1, status: "modified" },
        { path: "src/middleware/rateLimit.test.ts", additions: 22, deletions: 0, status: "added" },
        { path: "README.md", additions: 2, deletions: 0, status: "modified" },
      ],
      patch: README_PATCH,
      truncated: true,
    },
    600,
  );
  b.say(
    "msg_03",
    "assistant",
    "The key now uses the left-most X-Forwarded-For entry when `app.set(\"trust proxy\")` " +
      "is enabled, and falls back to req.ip otherwise.",
  );
  b.event("status", { status: "succeeded", reason: "Agent finished in 2 turns" }, 260);
  b.event("phase", { phase: "done" }, 120);

  return {
    id: b.runId,
    taskId: b.taskId,
    label: "Follow-up turn",
    blurb: "A second run on the same task. No setup phase — the container was still warm.",
    status: "succeeded",
    prompt: "Key on the X-Forwarded-For header when trust proxy is on.",
    events: b.events,
    frames: b.frames,
  };
}

export const mockRuns: MockRun[] = [
  buildSucceeded(),
  buildFollowUp(),
  buildCancelled(),
  buildBudgetExhausted(),
  buildTimedOut(),
  buildSetupFailed(),
];

export function runsForTask(taskId: string): MockRun[] {
  return mockRuns.filter((r) => r.taskId === taskId);
}

/** Every durable event for a task, in the order the history endpoint would return them. */
export function historyForTask(taskId: string): AnyEventRow[] {
  return runsForTask(taskId).flatMap((r) => r.events);
}

/** The playback script for a task: durable events with the token deltas interleaved. */
export function playbackForTask(taskId: string): PlaybackFrame[] {
  return runsForTask(taskId).flatMap((r) => r.frames);
}

export function runById(runId: string): MockRun | undefined {
  return mockRuns.find((r) => r.id === runId);
}
