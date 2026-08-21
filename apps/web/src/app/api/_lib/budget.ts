import "server-only";

import { eq } from "drizzle-orm";
import type { RunBudget } from "@codex-clone/core";
import { DEFAULT_BUDGET } from "@codex-clone/core";
import { settings, type Database } from "@codex-clone/db";

/**
 * The configured run bounds, for pages that render headroom.
 *
 * Read straight off the settings row rather than through `CredentialStore`:
 * these three numbers are not secret, and going through the store would make
 * every page that shows a budget depend on `APP_ENCRYPTION_KEY` being present.
 * A task page must not fail to render because a credential key is missing.
 *
 * The fallback is `DEFAULT_BUDGET` for the same reason the worker's is: it is
 * the budget an unconfigured install actually runs under, so showing anything
 * else would be showing a limit that is not being enforced.
 */
export async function readRunBudget(db: Database): Promise<RunBudget> {
  try {
    const [row] = await db
      .select({
        maxTurns: settings.budgetMaxTurns,
        maxCostUsd: settings.budgetMaxCostUsd,
        wallClockMs: settings.budgetWallClockMs,
      })
      .from(settings)
      .where(eq(settings.id, "singleton"))
      .limit(1);
    return row ?? DEFAULT_BUDGET;
  } catch {
    return DEFAULT_BUDGET;
  }
}
