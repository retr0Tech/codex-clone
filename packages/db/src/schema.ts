import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  doublePrecision,
  uniqueIndex,
  index,
  bigserial,
} from "drizzle-orm/pg-core";

/**
 * The COMPLETE initial schema, landed in commit 0 before any parallel work
 * starts. Milestone branches add files under their own directories; only one
 * milestone per wave is permitted to change this file, so migration ordering
 * never becomes a merge conflict.
 */

const id = () => text("id").primaryKey();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Single-row table. Local app, single user, no auth -- `id` is always 'singleton'. */
export const settings = pgTable("settings", {
  id: text("id").primaryKey().default("singleton"),
  /** AES-256-GCM ciphertext. Key derived from APP_ENCRYPTION_KEY, never stored. */
  githubTokenEnc: text("github_token_enc"),
  openaiKeyEnc: text("openai_key_enc"),
  /** Last 4 chars only, for masked display without decrypting. */
  githubTokenHint: text("github_token_hint"),
  openaiKeyHint: text("openai_key_hint"),
  defaultModel: text("default_model").notNull().default("gpt-5"),
  maxConcurrentSandboxes: integer("max_concurrent_sandboxes").notNull().default(3),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const repos = pgTable(
  "repos",
  {
    id: id(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    /** Repo-configured install step, run as a visible `setup` phase. */
    setupScript: text("setup_script"),
    /** Host bare mirror, cloned from locally so tasks don't each hit GitHub. */
    mirrorPath: text("mirror_path"),
    mirrorFetchedAt: timestamp("mirror_fetched_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("repos_full_name_idx").on(t.fullName)],
);

/** A Task is a chat / agent workspace. Archive is a status change, not a delete. */
export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    mode: text("mode", { enum: ["ask", "code"] }).notNull().default("code"),
    baseBranch: text("base_branch").notNull(),
    /** Pinned at creation; every diff is derived against this. */
    baseSha: text("base_sha").notNull(),
    workBranch: text("work_branch"),
    /** Hot-tier Docker volume. Null once reaped to the cold snapshot store. */
    volumeName: text("volume_name"),
    status: text("status", {
      enum: ["idle", "queued", "running", "archived"],
    })
      .notNull()
      .default("idle"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("tasks_status_idx").on(t.status), index("tasks_repo_idx").on(t.repoId)],
);

/** One agent invocation within a task. A follow-up turn is a new run. */
export const runs = pgTable(
  "runs",
  {
    id: id(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    status: text("status", {
      enum: ["queued", "running", "succeeded", "failed", "cancelled", "timed_out", "budget_exhausted"],
    })
      .notNull()
      .default("queued"),
    phase: text("phase", { enum: ["queued", "setup", "agent", "finalizing", "done"] })
      .notNull()
      .default("queued"),
    /** SandboxHandle.id -- opaque, provider-agnostic. */
    sandboxId: text("sandbox_id"),
    stopReason: text("stop_reason"),
    turns: integer("turns").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    /** Subset of inputTokens served from the prompt cache; reported by the gateway. */
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    /** Set when a scheduled job spawned this run. */
    scheduledExecutionId: text("scheduled_execution_id"),
    claimedBy: text("claimed_by"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // Drives the FOR UPDATE SKIP LOCKED claim used by the worker pool.
    index("runs_claim_idx").on(t.status, t.createdAt),
    index("runs_task_idx").on(t.taskId),
  ],
);

/**
 * Append-only transcript. `seq` is monotonic per run and is the cursor for
 * WebSocket backfill and reconnect. Live frames and history rows are the same
 * shape, so one client reducer serves both.
 */
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("events_run_seq_idx").on(t.runId, t.seq),
    index("events_task_idx").on(t.taskId, t.seq),
  ],
);

export const scheduledJobs = pgTable(
  "scheduled_jobs",
  {
    id: id(),
    name: text("name").notNull(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    /**
     * The branch every execution starts from. Added in milestone 9: a schedule
     * has to pin one, or an unattended job silently follows whatever the repo's
     * default branch happens to be that week. Each execution resolves it to a
     * fresh SHA at fire time -- that is the point of a schedule.
     */
    baseBranch: text("base_branch").notNull().default("main"),
    cronExpr: text("cron_expr").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    enabled: boolean("enabled").notNull().default(true),
    /** Skip if the previous execution is still running, or queue behind it. */
    onOverlap: text("on_overlap", { enum: ["skip", "queue"] }).notNull().default("skip"),
    /** After downtime: fire once on recovery, or not at all. */
    catchup: boolean("catchup").notNull().default(true),
    /** Auto-push results -- an unattended diff that dies with its container is useless. */
    autoPushBranch: boolean("auto_push_branch").notNull().default(true),
    autoOpenPr: boolean("auto_open_pr").notNull().default(false),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  // The scheduler tick: WHERE enabled AND next_run_at <= now() FOR UPDATE SKIP LOCKED
  (t) => [index("jobs_due_idx").on(t.enabled, t.nextRunAt)],
);

/** One occurrence of a scheduled job -- including the ones we deliberately skipped. */
export const scheduledExecutions = pgTable(
  "scheduled_executions",
  {
    id: id(),
    jobId: text("job_id")
      .notNull()
      .references(() => scheduledJobs.id, { onDelete: "cascade" }),
    /** Null when status is 'skipped' -- no workspace was created. */
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    status: text("status", {
      enum: ["claimed", "running", "succeeded", "failed", "skipped"],
    }).notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [index("executions_job_idx").on(t.jobId, t.scheduledFor)],
);

/** Cold tier. Written on idle reap, read on wake. */
export const snapshots = pgTable("snapshots", {
  taskId: text("task_id")
    .primaryKey()
    .references(() => tasks.id, { onDelete: "cascade" }),
  storePath: text("store_path").notNull(),
  digest: text("digest").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: createdAt(),
});
