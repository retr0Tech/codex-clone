import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export * as schema from "./schema.js";
export * from "./schema.js";
export * from "./event-log.js";

export type Database = ReturnType<typeof createDb>["db"];

/**
 * `max: 1` is deliberate for the worker's LISTEN connection; the pooled
 * connection used for queries is separate. Callers that need the claim query
 * (FOR UPDATE SKIP LOCKED) must run it inside a transaction.
 */
export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, { max: 10 });
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.end({ timeout: 5 }) };
}

/**
 * Dedicated connection for Postgres LISTEN/NOTIFY. The worker publishes event
 * rows here so any process can observe them; the WebSocket hub lives in the
 * worker itself, so this is primarily for future multi-worker fanout.
 */
export function createListener(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  return postgres(url, { max: 1 });
}

export const EVENTS_CHANNEL = "codex_events";
