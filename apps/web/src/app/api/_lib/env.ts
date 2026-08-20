import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Next.js reads `.env.local` relative to the app directory, but this is a
 * monorepo and the README tells the user to put it at the repo root (there is
 * one database and one encryption key for the whole system, not one per app).
 * So we walk up looking for it and fill in anything the environment does not
 * already define.
 *
 * A real `process.env` value always wins — this must never override what a
 * shell or CI has deliberately set.
 *
 * Underscore-prefixed directory: excluded from Next.js routing, so nothing in
 * `_lib` is ever reachable over HTTP.
 */

let loaded = false;

export function loadRepoEnv(): void {
  if (loaded) return;
  loaded = true;

  for (const file of findEnvFiles()) {
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const [key, value] of parseDotEnv(contents)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

function findEnvFiles(): string[] {
  const files: string[] = [];
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    files.push(join(dir, ".env.local"), join(dir, ".env"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return files;
}

/**
 * Deliberately minimal: `KEY=value`, `#` comments, optional surrounding
 * quotes. No interpolation and no multiline values — the only things we read
 * this way are a URL, a base64 key and a few numbers, and a clever parser here
 * would be a way to silently mangle a credential.
 */
function parseDotEnv(contents: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (value === "") continue;
    out.push([key, value]);
  }
  return out;
}
