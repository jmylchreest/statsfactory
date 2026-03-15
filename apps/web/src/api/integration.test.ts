/**
 * Integration test: sends events through the API and verifies ingestion.
 *
 * Uses Miniflare to create a real D1 database binding backed by in-memory
 * SQLite. Seeds an app with an API key, sends events via the Hono app,
 * and queries back to verify everything was stored correctly.
 *
 * Run: `bun run test -- src/api/integration.test.ts`
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import * as schema from "../db/schema";
import { ulid } from "./lib/ulid";
import { generateApiKey } from "./lib/crypto";
import app from "./index";

// ── State ───────────────────────────────────────────────────────────────────

let mf: Miniflare;
let d1: D1Database;
let testAppId: string;
let testApiKey: string;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Make a request to the Hono app with the D1 binding + dev mode. */
async function appRequest(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(path, "http://localhost");
  return app.request(url.pathname + url.search, init, {
    DB: d1,
    STATSFACTORY_DEV: "1",
  });
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  // Create a Miniflare instance with an in-memory D1 database
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "test-db-id" },
  });

  d1 = await mf.getD1Database("DB");

  // Create tables by executing raw SQL (matching the D1 migration schema).
  // Miniflare's D1 exec() can be unreliable with multi-statement strings,
  // so we execute each statement individually via batch().
  const stmts = [
    `CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      geo_precision TEXT NOT NULL DEFAULT 'country',
      retention_days INTEGER NOT NULL DEFAULT 90,
      enabled_dims TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS app_keys (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id),
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      raw_key TEXT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      session_id TEXT,
      distinct_id TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_events_app_time ON events(app_id, timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_events_app_name_time ON events(app_id, event_name, timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_events_session ON events(app_id, session_id)`,
    `CREATE TABLE IF NOT EXISTS event_dimensions (
      event_id TEXT NOT NULL REFERENCES events(id),
      dim_key TEXT NOT NULL,
      dim_value TEXT NOT NULL,
      dim_type TEXT NOT NULL DEFAULT 'string',
      PRIMARY KEY (event_id, dim_key)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_dims_key_value ON event_dimensions(dim_key, dim_value)`,
    `CREATE INDEX IF NOT EXISTS idx_dims_event ON event_dimensions(event_id)`,
  ];
  await d1.batch(stmts.map((sql) => d1.prepare(sql)));

  // Seed test app + API key
  testAppId = ulid();
  const now = new Date().toISOString();

  await d1.prepare(
    "INSERT INTO apps (id, name, geo_precision, retention_days, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(testAppId, "Integration Test App", "country", 90, now).run();

  const { rawKey, keyHash, keyPrefix } = await generateApiKey("live");
  testApiKey = rawKey;

  await d1.prepare(
    "INSERT INTO app_keys (id, app_id, key_hash, key_prefix, raw_key, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(ulid(), testAppId, keyHash, keyPrefix, rawKey, "Test key", now).run();
}, 30_000);

afterAll(async () => {
  if (mf) {
    await mf.dispose();
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Integration: Event Ingestion Pipeline", () => {
  it("should accept a batch of events via POST /v1/events", async () => {
    const res = await appRequest("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${testApiKey}`,
        "User-Agent": "statsfactory-sdk-ts/0.1.0 (test-app/1.0.0; linux; x64)",
      },
      body: JSON.stringify({
        events: [
          {
            event: "page_view",
            timestamp: "2026-03-14T10:00:00Z",
            session_id: "test-session-1",
            dimensions: {
              "page.path": "/home",
              "page.title": "Home Page",
            },
          },
          {
            event: "page_view",
            timestamp: "2026-03-14T10:01:00Z",
            session_id: "test-session-1",
            dimensions: {
              "page.path": "/about",
              "page.title": "About Page",
            },
          },
          {
            event: "button_click",
            timestamp: "2026-03-14T10:02:00Z",
            session_id: "test-session-1",
            dimensions: {
              "button.id": "signup",
              "button.label": "Sign Up",
            },
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { accepted: number; errors: unknown[] };
    expect(body.accepted).toBe(3);
    expect(body.errors).toHaveLength(0);
  });

  it("should reject events with invalid event names", async () => {
    const res = await appRequest("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${testApiKey}`,
      },
      body: JSON.stringify({
        events: [
          {
            event: "INVALID_NAME", // uppercase not allowed
            dimensions: {},
          },
        ],
      }),
    });

    // Zod validation rejects at the schema level
    expect(res.status).toBe(400);
  });

  it("should reject requests without auth", async () => {
    const res = await appRequest("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        events: [{ event: "test_event" }],
      }),
    });

    expect(res.status).toBe(401);
  });

  it("should query events time-series", async () => {
    const res = await appRequest(
      `/v1/query/events?app_id=${testAppId}&from=2026-03-01T00:00:00Z&to=2026-03-31T00:00:00Z&granularity=day`,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      time_series: Array<{ bucket: string; count: number }>;
      top_events: Array<{ eventName: string; count: number }>;
    };

    // Should have time series data for our events
    expect(body.time_series.length).toBeGreaterThanOrEqual(1);

    // Check total count
    const totalCount = body.time_series.reduce((sum, b) => sum + b.count, 0);
    expect(totalCount).toBeGreaterThanOrEqual(3);

    // Check top events
    expect(body.top_events.length).toBeGreaterThanOrEqual(1);
  });

  it("should query dimension keys", async () => {
    const res = await appRequest(
      `/v1/query/dimensions?app_id=${testAppId}&event_name=page_view`,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      dimensions: Array<{ dimKey: string; distinctValues: number }>;
    };

    // Should find page.path and page.title dimensions (plus enriched ones)
    const dimKeys = body.dimensions.map((d) => d.dimKey);
    expect(dimKeys).toContain("page.path");
    expect(dimKeys).toContain("page.title");
  });

  it("should query breakdown by dimension", async () => {
    const res = await appRequest(
      `/v1/query/breakdown?app_id=${testAppId}&event_name=page_view&dim_key=page.path&from=2026-03-01T00:00:00Z&to=2026-03-31T00:00:00Z`,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      breakdown: Array<{ value: string; count: number }>;
    };

    expect(body.breakdown.length).toBeGreaterThanOrEqual(2);
    const paths = body.breakdown.map((b) => b.value);
    expect(paths).toContain("/home");
    expect(paths).toContain("/about");
  });

  it("should query sessions list", async () => {
    const res = await appRequest(
      `/v1/query/sessions?app_id=${testAppId}&limit=10`,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      sessions: Array<{
        session_id: string;
        event_count: number;
        first_event: string;
        last_event: string;
        event_types: string[];
      }>;
    };

    expect(body.sessions.length).toBeGreaterThanOrEqual(1);

    const session = body.sessions.find((s) => s.session_id === "test-session-1");
    expect(session).toBeDefined();
    expect(session!.event_count).toBe(3);
    expect(session!.event_types).toContain("page_view");
    expect(session!.event_types).toContain("button_click");
  });

  it("should query session timeline", async () => {
    const res = await appRequest(
      `/v1/query/sessions/test-session-1?app_id=${testAppId}`,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      session_id: string;
      events: Array<{
        id: string;
        event_name: string;
        timestamp: string;
        dimensions: Record<string, string>;
      }>;
      meta: { event_count: number };
    };

    expect(body.session_id).toBe("test-session-1");
    expect(body.events.length).toBe(3);
    expect(body.meta.event_count).toBe(3);

    // Events should be ordered by timestamp
    expect(body.events[0].event_name).toBe("page_view");
    expect(body.events[0].dimensions["page.path"]).toBe("/home");
    expect(body.events[1].event_name).toBe("page_view");
    expect(body.events[1].dimensions["page.path"]).toBe("/about");
    expect(body.events[2].event_name).toBe("button_click");
    expect(body.events[2].dimensions["button.id"]).toBe("signup");
  });

  it("should query matrix cross-tabulation", async () => {
    // First send some more events for matrix testing
    await appRequest("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${testApiKey}`,
      },
      body: JSON.stringify({
        events: [
          {
            event: "plugin_used",
            timestamp: "2026-03-14T11:00:00Z",
            dimensions: {
              "plugin.name": "kitty",
              "plugin.status": "ok",
            },
          },
          {
            event: "plugin_used",
            timestamp: "2026-03-14T11:01:00Z",
            dimensions: {
              "plugin.name": "kitty",
              "plugin.status": "failed",
            },
          },
          {
            event: "plugin_used",
            timestamp: "2026-03-14T11:02:00Z",
            dimensions: {
              "plugin.name": "waybar",
              "plugin.status": "ok",
            },
          },
        ],
      }),
    });

    const res = await appRequest(
      `/v1/query/matrix?app_id=${testAppId}&event_name=plugin_used&dimensions=plugin.name&dimensions=plugin.status&from=2026-03-01T00:00:00Z&to=2026-03-31T00:00:00Z`,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      matrix: Array<Record<string, string | number>>;
    };

    expect(body.matrix.length).toBeGreaterThanOrEqual(3);

    // Find kitty+ok row
    const kittyOk = body.matrix.find(
      (r) => r["plugin.name"] === "kitty" && r["plugin.status"] === "ok",
    );
    expect(kittyOk).toBeDefined();
    expect(kittyOk!.count).toBe(1);
  });

  it("should query multi-event matrix with event_name as dimension", async () => {
    // Send events with a different event type
    await appRequest("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${testApiKey}`,
      },
      body: JSON.stringify({
        events: [
          {
            event: "plugin_installed",
            timestamp: "2026-03-14T12:00:00Z",
            dimensions: {
              "plugin.name": "kitty",
              "plugin.status": "ok",
            },
          },
          {
            event: "plugin_installed",
            timestamp: "2026-03-14T12:01:00Z",
            dimensions: {
              "plugin.name": "waybar",
              "plugin.status": "ok",
            },
          },
        ],
      }),
    });

    // Query with multiple event_name params — backend should auto-add event_name as dimension
    const res = await appRequest(
      `/v1/query/matrix?app_id=${testAppId}&event_name=plugin_used&event_name=plugin_installed&dimensions=plugin.name&from=2026-03-01T00:00:00Z&to=2026-03-31T00:00:00Z`,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      matrix: Array<Record<string, string | number>>;
      meta: {
        event_name: string | string[];
        dimensions: string[];
      };
    };

    // Should have event_name as a dimension
    expect(body.meta.dimensions).toContain("event_name");

    // meta.event_name should be an array
    expect(Array.isArray(body.meta.event_name)).toBe(true);
    expect(body.meta.event_name).toContain("plugin_used");
    expect(body.meta.event_name).toContain("plugin_installed");

    // Matrix should have rows with event_name field
    expect(body.matrix.length).toBeGreaterThanOrEqual(2);
    const pluginUsedKitty = body.matrix.find(
      (r) => r["event_name"] === "plugin_used" && r["plugin.name"] === "kitty",
    );
    expect(pluginUsedKitty).toBeDefined();

    const pluginInstalledKitty = body.matrix.find(
      (r) => r["event_name"] === "plugin_installed" && r["plugin.name"] === "kitty",
    );
    expect(pluginInstalledKitty).toBeDefined();
  });

  it("should list apps via management API", async () => {
    const res = await appRequest("/v1/apps");

    expect(res.status).toBe(200);
    const body = await res.json() as {
      apps: Array<{ id: string; name: string }>;
    };

    expect(body.apps.length).toBeGreaterThanOrEqual(1);
    const testApp = body.apps.find((a) => a.id === testAppId);
    expect(testApp).toBeDefined();
    expect(testApp!.name).toBe("Integration Test App");
  });

  it("should return health check", async () => {
    const res = await appRequest("/v1/health");
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });
});
