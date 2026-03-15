import { createClient } from "@libsql/client/web";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Env = {
  /** Cloudflare D1 binding (preferred). */
  DB?: D1Database;
  /** Turso/libSQL HTTP URL (fallback). */
  TURSO_DATABASE_URL?: string;
  /** Turso auth token (required when using TURSO_DATABASE_URL). */
  TURSO_AUTH_TOKEN?: string;
};

/**
 * Create a Drizzle DB instance from CF Worker env bindings.
 *
 * Resolution order:
 *  1. D1 binding (`env.DB`) — zero-latency, colocated with the Worker.
 *  2. Turso/libSQL (`env.TURSO_DATABASE_URL`) — HTTP transport, works on
 *     both Cloudflare Workers and local dev with a libSQL HTTP server.
 */
export function createDb(env: Env) {
  if (env.DB) {
    return drizzleD1(env.DB, { schema });
  }

  if (env.TURSO_DATABASE_URL) {
    const client = createClient({
      url: env.TURSO_DATABASE_URL,
      authToken: env.TURSO_AUTH_TOKEN,
    });
    return drizzleLibsql(client, { schema });
  }

  throw new Error(
    "No database configured. Provide a D1 binding (DB) or TURSO_DATABASE_URL.",
  );
}

export type Database = ReturnType<typeof createDb>;
