import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "drizzle-kit";

/**
 * Load the repository-root .env.local, exactly as apps/web/next.config.ts does.
 *
 * drizzle-kit reads no dotenv file of its own, so without this `pnpm db:migrate`
 * always migrates the default database -- which is fine in a single-workspace
 * checkout and wrong in every other one. A parallel workspace has its own
 * DATABASE_URL in its own .env.local, and migrating the wrong database is the
 * kind of mistake you only notice two branches later.
 *
 * Real environment variables always win, so an explicit
 * `DATABASE_URL=... pnpm db:migrate` still does what it says.
 */
function loadRootEnv(): void {
  const envPath = join(process.cwd(), "..", "..", ".env.local");
  if (!existsSync(envPath)) return;

  for (const rawLine of readFileSync(envPath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;

    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
      const quote = value[0]!;
      if (value.endsWith(quote)) value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadRootEnv();

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://codex:codex@localhost:5432/codex_clone",
  },
});
