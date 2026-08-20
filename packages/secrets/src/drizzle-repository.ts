/**
 * The production `SettingsRepository`: the singleton `settings` row.
 *
 * Kept in its own module so `store.ts` — where all the crypto and redaction
 * logic lives — has no dependency on a live database and can be unit-tested
 * against `inMemorySettingsRepository`.
 */

import { eq } from "drizzle-orm";
import { settings, type Database } from "@codex-clone/db";
import { DEFAULT_SETTINGS, type SettingsPatch, type SettingsRepository, type StoredSettings } from "./store.js";

/** Local app, single user, no auth — there is exactly one settings row. */
export const SETTINGS_ROW_ID = "singleton";

export function drizzleSettingsRepository(db: Database): SettingsRepository {
  return {
    async read(): Promise<StoredSettings | null> {
      const [row] = await db.select().from(settings).where(eq(settings.id, SETTINGS_ROW_ID)).limit(1);
      if (!row) return null;
      return {
        githubTokenEnc: row.githubTokenEnc,
        openaiKeyEnc: row.openaiKeyEnc,
        githubTokenHint: row.githubTokenHint,
        openaiKeyHint: row.openaiKeyHint,
        defaultModel: row.defaultModel,
        maxConcurrentSandboxes: row.maxConcurrentSandboxes,
      };
    },

    async write(patch: SettingsPatch): Promise<void> {
      const updatedAt = new Date();
      // Upsert rather than update: the row does not exist until the user saves
      // for the first time, and a missing row must not be a silent no-op.
      await db
        .insert(settings)
        .values({ id: SETTINGS_ROW_ID, ...DEFAULT_SETTINGS, ...patch, updatedAt })
        .onConflictDoUpdate({ target: settings.id, set: { ...patch, updatedAt } });
    },
  };
}
