import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import app from "../../api/index";

/**
 * Catch-all Astro API route that delegates all /v1/* requests to Hono.
 *
 * Astro handles static pages and dashboard routes.
 * Hono handles the API (ingestion, query, management).
 *
 * All CF Worker bindings are forwarded so the Hono app can use
 * D1, Turso, and CF Access auth.
 */
export const ALL: APIRoute = (context) => {
  return app.fetch(context.request, {
    DB: env.DB,
    TURSO_DATABASE_URL: env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: env.TURSO_AUTH_TOKEN,
    CF_ACCESS_TEAM_DOMAIN: env.CF_ACCESS_TEAM_DOMAIN,
  });
};
