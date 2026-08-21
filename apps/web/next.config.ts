import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

/**
 * Load the repository-root .env.local.
 *
 * Next only reads .env files from its own project directory, but this is a
 * monorepo: the web app and the worker share one configuration file at the
 * root so a contributor fills in exactly one place. Without this, following
 * the README ("cp .env.example .env.local") would leave the web app without
 * DATABASE_URL or APP_ENCRYPTION_KEY.
 *
 * Real environment variables always win, so CI and production are unaffected.
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

const nextConfig: NextConfig = {};

export default nextConfig;
