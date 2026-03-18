/**
 * Custom Cloudflare Worker entry point.
 *
 * Delegates HTTP fetch requests to the default Astro handler, and adds a
 * `scheduled` handler for the data retention cron trigger.
 *
 * The cron trigger ("0 3 * * *") is configured via the Cloudflare SDK
 * in scripts/deploy.ts for production, and in wrangler.dev.toml for local dev.
 */
import { handle } from "@astrojs/cloudflare/handler";
import { createDb } from "./db/client";
import { runRetention } from "./api/lib/retention";

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext) {
    return handle(request, env, ctx);
  },

  async scheduled(
    controller: ScheduledController,
    env: { DB: D1Database },
    ctx: ExecutionContext,
  ) {
    const db = createDb(env);

    ctx.waitUntil(
      runRetention(db).then((result) => {
        console.log(
          `Retention complete: ${result.appsProcessed} apps, ${result.eventsDeleted} events deleted` +
            (result.errors.length > 0 ? `, ${result.errors.length} errors` : ""),
        );
        if (result.errors.length > 0) {
          console.error("Retention errors:", result.errors);
        }
      }),
    );
  },
};
