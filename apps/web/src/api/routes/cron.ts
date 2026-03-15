import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { runRetention } from "../lib/retention";
import type { AppEnv } from "../index";

export const cronRouter = new OpenAPIHono<AppEnv>();

// ── Response schema ─────────────────────────────────────────────────────────

const RetentionResponseSchema = z
  .object({
    appsProcessed: z.number(),
    eventsDeleted: z.number(),
    errors: z.array(z.string()),
  })
  .openapi("RetentionResponse");

// ── POST /v1/cron/retention ─────────────────────────────────────────────────

const retentionRoute = createRoute({
  method: "post",
  path: "/cron/retention",
  tags: ["Cron"],
  summary: "Run data retention cleanup",
  description:
    "Delete events older than each app's retention_days. " +
    "Intended to be called by a Cloudflare Cron Trigger or manually for testing. " +
    "Protected by Cloudflare Access.",
  security: [{ CfAccess: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: RetentionResponseSchema } },
      description: "Retention completed.",
    },
  },
});

cronRouter.openapi(retentionRoute, async (c) => {
  const db = c.get("db");
  const result = await runRetention(db);
  return c.json(result);
});
