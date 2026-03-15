import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

/**
 * Create a Drizzle DB instance from a Cloudflare D1 binding.
 */
export function createDb(env: { DB: D1Database }) {
  return drizzle(env.DB, { schema });
}

export type Database = ReturnType<typeof createDb>;
