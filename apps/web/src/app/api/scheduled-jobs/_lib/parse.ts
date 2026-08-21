import { InvalidCronError, validateCron } from "@codex-clone/cron";
import type { OnOverlap } from "../../../../lib/scheduled";

/**
 * Request validation for scheduled jobs.
 *
 * Deliberately free of `server-only` and of any database import, so it can be
 * unit-tested directly. That matters more here than for most validators: an
 * invalid cron expression accepted at this door does not fail now, it fails at
 * 3am in a worker nobody is watching -- so the expression is not merely
 * pattern-checked but actually resolved to a first occurrence before the row is
 * allowed to exist.
 *
 * Underscore-prefixed directory: excluded from Next.js routing, so nothing in
 * here is reachable over HTTP.
 */

export class InvalidScheduledJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidScheduledJobError";
  }
}

export const MAX_PROMPT_BYTES = 32 * 1024;
export const MAX_NAME_LENGTH = 80;

/** `owner/name`, the only shape the rest of the system addresses a repo by. */
const FULL_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** Deliberately permissive: git refs allow a lot, but not these. */
const BAD_REF = /(^-|\.\.|[\s~^:?*[\\]|@\{|\/$|^\/)/;

export interface CreateScheduledJobInput {
  name: string;
  repoFullName: string;
  baseBranch: string;
  prompt: string;
  /** Canonical five-field form, as `normalizeCron` produced it. */
  cronExpr: string;
  timezone: string;
  enabled: boolean;
  onOverlap: OnOverlap;
  catchup: boolean;
  autoPushBranch: boolean;
  autoOpenPr: boolean;
  /** The first occurrence, computed here so the row is never written without one. */
  nextRunAt: Date;
}

export function parseCreateScheduledJob(body: unknown, now: Date = new Date()): CreateScheduledJobInput {
  const o = asObject(body);

  const repoFullName = str(o["repoFullName"], "repoFullName");
  if (!FULL_NAME.test(repoFullName)) {
    throw new InvalidScheduledJobError(`repoFullName must look like "owner/name", got "${repoFullName}"`);
  }

  const baseBranch = str(o["baseBranch"], "baseBranch");
  if (BAD_REF.test(baseBranch)) {
    throw new InvalidScheduledJobError(`"${baseBranch}" is not a usable branch name`);
  }

  const prompt = str(o["prompt"], "prompt");
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new InvalidScheduledJobError(`prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
  }

  const name = trimmedName(o["name"], prompt);
  const timezone = o["timezone"] === undefined ? "UTC" : str(o["timezone"], "timezone");
  const cron = cronOrThrow(str(o["cronExpr"], "cronExpr"), timezone, now);

  const autoOpenPr = bool(o["autoOpenPr"], "autoOpenPr", false);
  const autoPushBranch = bool(o["autoPushBranch"], "autoPushBranch", true);
  // A pull request without a branch is not a state that exists. Saying so beats
  // silently storing a combination the worker would have to reinterpret.
  if (autoOpenPr && !autoPushBranch) {
    throw new InvalidScheduledJobError("autoOpenPr requires autoPushBranch: a pull request needs a branch to open from");
  }

  return {
    name,
    repoFullName,
    baseBranch,
    prompt,
    cronExpr: cron.expression,
    timezone,
    enabled: bool(o["enabled"], "enabled", true),
    onOverlap: overlap(o["onOverlap"]),
    catchup: bool(o["catchup"], "catchup", true),
    autoPushBranch,
    autoOpenPr,
    nextRunAt: cron.next,
  };
}

export interface UpdateScheduledJobInput {
  name?: string;
  baseBranch?: string;
  prompt?: string;
  cronExpr?: string;
  timezone?: string;
  enabled?: boolean;
  onOverlap?: OnOverlap;
  catchup?: boolean;
  autoPushBranch?: boolean;
  autoOpenPr?: boolean;
}

/**
 * A partial update: only the keys actually present are returned.
 *
 * The enable/disable toggle is `PATCH {enabled}` rather than an endpoint of its
 * own, because it is the same write with the same recomputation of
 * `next_run_at` behind it -- see `applyUpdate` in `jobs.ts` for why enabling a
 * job has to move that timestamp.
 */
export function parseUpdateScheduledJob(body: unknown, current: { cronExpr: string; timezone: string }): UpdateScheduledJobInput {
  const o = asObject(body);
  const patch: UpdateScheduledJobInput = {};

  if (o["name"] !== undefined) patch.name = trimmedName(o["name"], "");
  if (o["prompt"] !== undefined) {
    const prompt = str(o["prompt"], "prompt");
    if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
      throw new InvalidScheduledJobError(`prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
    }
    patch.prompt = prompt;
  }
  if (o["baseBranch"] !== undefined) {
    const baseBranch = str(o["baseBranch"], "baseBranch");
    if (BAD_REF.test(baseBranch)) throw new InvalidScheduledJobError(`"${baseBranch}" is not a usable branch name`);
    patch.baseBranch = baseBranch;
  }
  if (o["enabled"] !== undefined) patch.enabled = bool(o["enabled"], "enabled", true);
  if (o["onOverlap"] !== undefined) patch.onOverlap = overlap(o["onOverlap"]);
  if (o["catchup"] !== undefined) patch.catchup = bool(o["catchup"], "catchup", true);
  if (o["autoPushBranch"] !== undefined) patch.autoPushBranch = bool(o["autoPushBranch"], "autoPushBranch", true);
  if (o["autoOpenPr"] !== undefined) patch.autoOpenPr = bool(o["autoOpenPr"], "autoOpenPr", false);

  // The schedule is validated as a PAIR even when only one half was sent: a
  // valid expression in a timezone nobody has heard of is still a job that
  // never runs, and either field alone can produce that.
  if (o["cronExpr"] !== undefined || o["timezone"] !== undefined) {
    const timezone = o["timezone"] === undefined ? current.timezone : str(o["timezone"], "timezone");
    const expr = o["cronExpr"] === undefined ? current.cronExpr : str(o["cronExpr"], "cronExpr");
    const cron = cronOrThrow(expr, timezone, new Date());
    patch.cronExpr = cron.expression;
    patch.timezone = timezone;
  }

  const push = patch.autoPushBranch;
  const pr = patch.autoOpenPr;
  if (pr === true && push === false) {
    throw new InvalidScheduledJobError("autoOpenPr requires autoPushBranch: a pull request needs a branch to open from");
  }

  if (Object.keys(patch).length === 0) {
    throw new InvalidScheduledJobError("nothing to update");
  }
  return patch;
}

function cronOrThrow(expr: string, timezone: string, now: Date) {
  try {
    return validateCron(expr, timezone, now);
  } catch (error) {
    if (error instanceof InvalidCronError) throw new InvalidScheduledJobError(error.message);
    throw error;
  }
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidScheduledJobError("the request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function str(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidScheduledJobError(`${name} is required`);
  }
  return value.trim();
}

function bool(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new InvalidScheduledJobError(`${name} must be true or false`);
  return value;
}

function overlap(value: unknown): OnOverlap {
  if (value === undefined) return "skip";
  if (value !== "skip" && value !== "queue") {
    throw new InvalidScheduledJobError(`onOverlap must be "skip" or "queue"`);
  }
  return value;
}

/** A name, or the first line of the prompt when none was given. */
function trimmedName(value: unknown, prompt: string): string {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    const line = prompt.split("\n").find((l) => l.trim() !== "")?.trim() ?? "Scheduled job";
    return line.length > MAX_NAME_LENGTH ? `${line.slice(0, MAX_NAME_LENGTH - 1)}…` : line;
  }
  if (typeof value !== "string") throw new InvalidScheduledJobError("name must be a string");
  const name = value.trim();
  if (name.length > MAX_NAME_LENGTH) {
    throw new InvalidScheduledJobError(`name must be ${MAX_NAME_LENGTH} characters or fewer`);
  }
  return name;
}
