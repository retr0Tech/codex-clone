import { Cron } from "croner";

/**
 * Cron expressions, with a timezone (PLAN.md §3.5).
 *
 * A package of its own rather than a file in @codex-clone/core, for two
 * reasons: core is the frozen-contracts package and has no runtime dependency
 * at all -- it is imported by the agent runtime, which ships inside the sandbox
 * image and has no business carrying a scheduler -- and BOTH the web app and
 * the worker need this. The web app validates an expression and computes the
 * first `next_run_at` when a job is created; the worker computes every one
 * after that. Two implementations of "when does this fire next" is how a
 * schedule comes to disagree with the page that shows it.
 *
 * `croner` does the parsing: zero dependencies, timezone support via `Intl`
 * (so DST is the platform's problem, not ours), and pinned to an exact version
 * because a subtle change in what an expression means is not something a
 * caret range should be allowed to deliver.
 *
 * Deliberately narrower than croner's own grammar:
 *
 *  - **Five fields only.** croner also accepts a six-field form with seconds.
 *    The tick is 30s and `next_run_at` is a timestamp, so a per-second schedule
 *    would either be missed or would hammer the queue; refusing it at the door
 *    beats explaining it afterwards.
 *  - **Nicknames are expanded here**, not passed through, so everything stored
 *    in `scheduled_jobs.cron_expr` is one canonical five-field shape.
 */

export class InvalidCronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCronError";
  }
}

/** The five-field shapes people actually reach for a nickname to avoid typing. */
const NICKNAMES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

/**
 * Canonical five-field form, or a thrown `InvalidCronError`.
 *
 * Every write path runs input through this, so `scheduled_jobs.cron_expr` never
 * holds something the worker will choke on at 3am with nobody watching.
 */
export function normalizeCron(expr: string): string {
  const trimmed = expr.trim().toLowerCase();
  if (trimmed === "") throw new InvalidCronError("a cron expression is required");

  const nickname = NICKNAMES[trimmed];
  if (nickname) return nickname;
  if (trimmed.startsWith("@")) {
    throw new InvalidCronError(
      `"${expr}" is not a cron expression I understand; the nicknames are ${Object.keys(NICKNAMES).join(", ")}`,
    );
  }

  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new InvalidCronError(
      `a cron expression needs 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}: "${expr}"`,
    );
  }
  return fields.join(" ");
}

/** True when the IANA name is one this platform's `Intl` actually knows. */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export interface ValidatedCron {
  /** The canonical five-field expression to store. */
  expression: string;
  timezone: string;
  /** First occurrence strictly after `from`. Handy for showing what was meant. */
  next: Date;
}

/**
 * Validates an expression AND its timezone together, because a valid
 * expression in a timezone nobody has heard of is still a job that never runs.
 *
 * Returns the first occurrence as well: a schedule the user cannot preview is
 * one they find out about the hard way.
 */
export function validateCron(expr: string, timezone: string, from: Date = new Date()): ValidatedCron {
  if (!isValidTimezone(timezone)) {
    throw new InvalidCronError(`"${timezone}" is not an IANA timezone name (try "UTC" or "Europe/London")`);
  }
  const expression = normalizeCron(expr);
  const next = nextCronRun(expression, timezone, from);
  return { expression, timezone, next };
}

/**
 * The first occurrence strictly after `from`, in `timezone`.
 *
 * "Strictly after" is the property the scheduler leans on: `next_run_at` is
 * always recomputed from a moment at or after the one that just fired, so a
 * boundary-exact `from` cannot hand back the same instant and fire twice.
 */
export function nextCronRun(expr: string, timezone: string, from: Date = new Date()): Date {
  if (Number.isNaN(from.getTime())) throw new InvalidCronError("`from` is not a valid date");
  if (!isValidTimezone(timezone)) {
    throw new InvalidCronError(`"${timezone}" is not an IANA timezone name (try "UTC" or "Europe/London")`);
  }

  const expression = normalizeCron(expr);
  let cron: Cron;
  try {
    cron = new Cron(expression, { timezone });
  } catch (error) {
    throw new InvalidCronError(
      `"${expr}" is not a usable cron expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const next = cron.nextRun(from);
  if (!next) {
    // `0 0 30 2 *` parses and simply never happens. Better a refusal at the
    // door than a row whose next_run_at can never be filled in.
    throw new InvalidCronError(`"${expr}" has no next occurrence in ${timezone}; it can never run`);
  }
  return next;
}

/** The next `count` occurrences, for a "this is what you just asked for" preview. */
export function nextCronRuns(expr: string, timezone: string, count: number, from: Date = new Date()): Date[] {
  const out: Date[] = [];
  let cursor = from;
  for (let i = 0; i < count; i += 1) {
    cursor = nextCronRun(expr, timezone, cursor);
    out.push(cursor);
  }
  return out;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/**
 * A plain-English gloss of the common shapes, or null.
 *
 * Deliberately partial. A cron humaniser that tries to describe everything ends
 * up producing sentences less readable than the expression it replaced, so this
 * covers the four patterns people actually write and returns null otherwise --
 * and the UI shows the raw expression, which is never wrong.
 */
export function describeCron(expr: string): string | null {
  let fields: string[];
  try {
    fields = normalizeCron(expr).split(" ");
  } catch {
    return null;
  }
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];

  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (everyMinutes && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    const n = Number(everyMinutes[1]);
    return n === 1 ? "Every minute" : `Every ${n} minutes`;
  }

  const everyHours = /^\*\/(\d+)$/.exec(hour);
  if (/^\d+$/.test(minute) && everyHours && dom === "*" && month === "*" && dow === "*") {
    const n = Number(everyHours[1]);
    return `Every ${n === 1 ? "hour" : `${n} hours`} at ${minute.padStart(2, "0")} past`;
  }

  if (/^\d+$/.test(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `Hourly at ${minute.padStart(2, "0")} past`;
  }

  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && month === "*") {
    const at = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
    if (dom === "*" && dow === "*") return `Daily at ${at}`;
    if (dom === "*" && /^\d$/.test(dow)) return `Weekly on ${DAYS[Number(dow) % 7]} at ${at}`;
    if (dom === "*" && dow === "1-5") return `Weekdays at ${at}`;
    if (/^\d+$/.test(dom) && dow === "*") return `Monthly on day ${dom} at ${at}`;
  }

  return null;
}
