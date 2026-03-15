import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { createDb, type Database } from "../db/client";
import { appKeyAuth, cfAccessAuth } from "./middleware/auth";
import { enrichMiddleware } from "./middleware/enrich";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { ingestRouter } from "./routes/ingest";
import { manageRouter } from "./routes/manage";
import { queryRouter } from "./routes/query";
import { cronRouter } from "./routes/cron";
import { HealthResponseSchema } from "./lib/schemas";

// ── Types ───────────────────────────────────────────────────────────────────

export type AppEnv = {
  Bindings: {
    DB?: D1Database;
    TURSO_DATABASE_URL?: string;
    TURSO_AUTH_TOKEN?: string;
    CF_ACCESS_TEAM_DOMAIN?: string;
  };
  Variables: {
    db: Database;
    appId: string;
    cfAccessEmail: string;
    enrichedDimensions: Record<string, string>;
  };
};

const app = new OpenAPIHono<AppEnv>().basePath("/v1");

// ── Global middleware ────────────────────────────────────────────────────────

// CORS — allow SDKs from any origin
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["POST", "GET", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
  }),
);

// DB middleware — create Drizzle instance from env bindings
app.use("*", async (c, next) => {
  const db = createDb(c.env);
  // Enable foreign key enforcement for D1 (required for ON DELETE CASCADE)
  if (c.env.DB) {
    await c.env.DB.exec("PRAGMA foreign_keys = ON");
  }
  c.set("db", db);
  await next();
});

// ── Ingest routes (app key auth + rate limit + enrichment) ──────────────────

app.use("/events", appKeyAuth);
app.use("/events", rateLimitMiddleware);
app.use("/events", enrichMiddleware);
app.route("/", ingestRouter);

// ── Management routes (CF Access auth) ───────────────────────────────────────

app.use("/apps", cfAccessAuth);
app.use("/apps/*", cfAccessAuth);
app.route("/", manageRouter);

// ── Query routes (CF Access auth) ────────────────────────────────────────────

app.use("/query/*", cfAccessAuth);
app.route("/", queryRouter);

// ── Cron routes (CF Access auth) ─────────────────────────────────────────────

app.use("/cron/*", cfAccessAuth);
app.route("/", cronRouter);

// ── Health check ─────────────────────────────────────────────────────────────

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["System"],
  summary: "Health check",
  description: "Returns server status. No authentication required.",
  responses: {
    200: {
      content: { "application/json": { schema: HealthResponseSchema } },
      description: "Server is healthy.",
    },
  },
});

app.openapi(healthRoute, (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── OpenAPI documentation endpoint ───────────────────────────────────────────

app.doc("/doc", {
  openapi: "3.1.0",
  info: {
    title: "StatsFactory API",
    version: "1.0.0",
    description:
      "Self-hosted, privacy-first analytics platform with multi-dimension querying.",
  },
});

// Register security schemes
app.openAPIRegistry.registerComponent("securitySchemes", "AppKeyAuth", {
  type: "http",
  scheme: "bearer",
  description: "App key for event ingestion (sf_live_xxx).",
});

app.openAPIRegistry.registerComponent("securitySchemes", "CfAccess", {
  type: "apiKey",
  in: "header",
  name: "Cf-Access-Authenticated-User-Email",
  description:
    "Cloudflare Access identity. Set automatically by CF Access proxy in production. In dev mode, this is optional.",
});

export default app;
export type App = typeof app;
