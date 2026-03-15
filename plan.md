# statsfactory - Project Plan

A self-hosted, privacy-first analytics platform for apps, running on Cloudflare
Workers free tier with Turso (libSQL). A richer alternative to Aptabase with
PostHog-inspired multi-dimension querying.

## Problem Statement

Aptabase provides simple, privacy-first analytics but has critical limitations:

- **Flat property model**: Only strings and numbers, no structured/nested data
- **Single-dimension breakdowns**: Can only break down by ONE property at a time
- **No cross-event correlation**: Can't query across related events in a session
- **No server-side enrichment**: Geo, network, and UA data must be sent by client
- **Workarounds required**: Comma-joining lists (`output_plugins: "kitty,waybar"`),
  emitting N+1 events to work around lack of per-item detail on summary events,
  duplicating version in props AND systemProps because breakdown reliability is poor

PostHog solves many of these but is heavy, expensive at scale, and even it can't
natively break down by multiple properties simultaneously (requires HogQL concat
hacks).

### Real-World Example: Tinct

Tinct (`tinct generate`) currently sends to Aptabase:

- 1x `generate` event with flat props: `input_plugin`, `output_plugins` (comma-joined),
  `theme_type`, `seed_mode`, `backend`, `extract_ambience`, `dry_run`, `dual_theme`, `ai_input`
- Nx `plugin_used` events (one per output plugin): `plugin_name`, `plugin_version`,
  `is_external`, `status`

**Questions Aptabase cannot answer:**

| Question | Why it fails |
|----------|-------------|
| Which plugin versions fail most? | Can't break down `plugin_name` x `plugin_version` x `status` |
| Do external plugins fail more than built-in? | Can't cross-tabulate `is_external` x `status` |
| What plugins are popular in NZ vs EU? | No geo data captured |
| Which OS+arch combos use AI input? | No server-side OS enrichment, can't multi-break |
| Are dark themes more popular in certain regions? | No geo, can't cross with `theme_type` |

## Solution: Dimension Maps

### Core Concept

Every event carries a **map of typed attribute dimensions** using dot-notation
keys that the system understands as grouped:

```json
{
  "event": "plugin_used",
  "dimensions": {
    "plugin.name": "kitty",
    "plugin.version": "0.1.27",
    "plugin.external": false,
    "plugin.status": "ok"
  }
}
```

The dot-notation is semantic: the dashboard treats `plugin.*` as a dimension
group, enabling multi-dimension breakdowns, cross-tabulation, and grouped
filtering that Aptabase cannot do.

### Server-Side Enrichment

The Cloudflare Worker automatically enriches every event with request metadata
at zero cost (CF provides this on the `request.cf` object):

| Dimension | Source | Example |
|-----------|--------|---------|
| `geo.country` | `request.cf.country` | `"NZ"` |
| `geo.region` | `request.cf.region` | `"WLG"` |
| `geo.city` | `request.cf.city` | `"Wellington"` |
| `geo.continent` | `request.cf.continent` | `"OC"` |
| `geo.timezone` | `request.cf.timezone` | `"Pacific/Auckland"` |
| `geo.latitude` | `request.cf.latitude` | `"-41.2865"` |
| `geo.longitude` | `request.cf.longitude` | `"174.7762"` |
| `net.asn` | `request.cf.asn` | `13335` |
| `net.as_org` | `request.cf.asOrganization` | `"Cloudflare Inc"` |
| `net.colo` | `request.cf.colo` | `"SYD"` |
| `net.tls_version` | `request.cf.tlsVersion` | `"TLSv1.3"` |
| `net.http_protocol` | `request.cf.httpProtocol` | `"HTTP/2"` |

### User-Agent Convention

SDKs set a structured User-Agent that the server parses:

```
User-Agent: statsfactory-sdk-go/0.1.0 (tinct/0.1.27; linux; amd64)
```

Server extracts:

| Dimension | Value |
|-----------|-------|
| `sdk.name` | `statsfactory-sdk-go` |
| `sdk.version` | `0.1.0` |
| `client.name` | `tinct` |
| `client.version` | `0.1.27` |
| `client.os` | `linux` |
| `client.arch` | `amd64` |

For browser User-Agents (web apps), the server parses into `client.browser`,
`client.browser_version`, `client.os`, `client.os_version`, `client.device_type`.

### Privacy Design

- **No IP stored** - used for geo lookup via CF, never persisted
- **No fingerprinting** - no cookies, no persistent device ID unless app explicitly
  sends `distinct_id`
- **Geo precision configurable per app** - `"country"`, `"city"`, or `"none"`
- **Identity optional** - `session_id` and `distinct_id` are opt-in
- **Installation ID** - apps may send an anonymous installation hash (like Tinct
  does today), but it's just another dimension, not a tracked user

## Architecture

```
+-------------+     +------------------------------------------+
|  Your Apps  |---->|  Cloudflare Worker (Hono)                |
|  (SDKs)     |     |                                          |
+-------------+     |  POST /v1/events     <- Ingestion API    |
                    |  GET  /v1/query      <- Query API         |
                    |  POST /v1/apps       <- Management API    |
                    |  GET  /*             <- Dashboard (Astro) |
                    |                                          |
|  Middleware:                              |
|  - App key auth (ingestion only)         |
|  - Cloudflare Access (dashboard/query)   |
|  - CORS                                  |
|  - Server-side enrichment (geo/UA)        |
                    |                                          |
                    |  Ingestion Pipeline:                     |
                    |  - Validate event + dimensions            |
                    |  - Generate ULID                          |
                    |  - Enrich with CF request metadata        |
                    |  - Parse User-Agent                       |
                    |  - Batch insert to Turso                  |
                    |  - Update rollup tables                   |
                    +------------------+-----------------------+
                                       |
                    +------------------v-----------------------+
                    |  Turso (libSQL)                           |
                    |  - events + event_dimensions (raw)        |
                    |  - rollups_hourly / rollups_daily          |
                    |  - apps + app_keys                        |
                    +------------------------------------------+
```

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| **Runtime** | Cloudflare Workers | Free: 100K req/day, 10ms CPU/req |
| **Backend** | Hono (TypeScript) | Purpose-built for Workers, fast, typed |
| **Frontend** | Astro + `@astrojs/cloudflare` | First-class Workers support, islands arch |
| **UI** | Tailwind CSS | Standard, works well with Astro |
| **Charts** | TBD (Recharts, Chart.js, or uPlot) | Trend lines, bar charts, dimension matrices |
| **Database** | Turso (libSQL) | 5GB free, 500M reads, 10M writes/month |
| **Dashboard Auth** | Cloudflare Access (Zero Trust) | Free for <50 users, no custom auth code |
| **IDs** | ULID | Time-sortable, URL-safe, no coordination |
| **Monorepo** | Turborepo + pnpm | Worker + dashboard + SDK packages |

## Database Schema

### Core Tables

```sql
-- Apps that send telemetry
CREATE TABLE apps (
  id TEXT PRIMARY KEY,                -- ulid
  name TEXT NOT NULL,
  geo_precision TEXT NOT NULL DEFAULT 'country',  -- 'country', 'city', 'none'
  retention_days INTEGER NOT NULL DEFAULT 90,
  created_at TEXT NOT NULL
);

-- App keys for ingestion (public keys embedded in client SDKs)
CREATE TABLE app_keys (
  id TEXT PRIMARY KEY,                -- ulid
  app_id TEXT NOT NULL REFERENCES apps(id),
  key_hash TEXT NOT NULL,             -- sha256 of actual key
  key_prefix TEXT NOT NULL,           -- first 8 chars for display
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- Core events table
CREATE TABLE events (
  id TEXT PRIMARY KEY,                -- ulid (time-sortable)
  app_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  timestamp TEXT NOT NULL,            -- ISO 8601, client-provided
  session_id TEXT,                    -- optional, SDK-generated
  distinct_id TEXT,                   -- optional, app-provided identity
  created_at TEXT NOT NULL            -- server receive time
);

-- Dimension values (EAV pattern: one row per dimension per event)
CREATE TABLE event_dimensions (
  event_id TEXT NOT NULL REFERENCES events(id),
  dim_key TEXT NOT NULL,              -- e.g. "plugin.name", "geo.country"
  dim_value TEXT NOT NULL,            -- stored as text, typed at query time
  dim_type TEXT NOT NULL DEFAULT 'string',  -- string, number, boolean
  PRIMARY KEY (event_id, dim_key)
);

-- Indexes for query patterns
CREATE INDEX idx_events_app_time ON events(app_id, timestamp);
CREATE INDEX idx_events_app_name_time ON events(app_id, event_name, timestamp);
CREATE INDEX idx_events_session ON events(app_id, session_id);
CREATE INDEX idx_dims_key_value ON event_dimensions(dim_key, dim_value);
CREATE INDEX idx_dims_event ON event_dimensions(event_id);
```

### Rollup Tables (Dashboard Performance)

```sql
CREATE TABLE rollups_hourly (
  app_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  dim_key TEXT,                       -- NULL for event-level counts
  dim_value TEXT,
  hour TEXT NOT NULL,                 -- "2026-03-14T10"
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, event_name, dim_key, dim_value, hour)
);

CREATE TABLE rollups_daily (
  app_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  dim_key TEXT,
  dim_value TEXT,
  day TEXT NOT NULL,                  -- "2026-03-14"
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, event_name, dim_key, dim_value, day)
);
```

### Why EAV for Dimensions

- **SQL-native filtering**: `WHERE dim_key = 'plugin.name' AND dim_value = 'kitty'`
  is indexable, no JSON functions needed
- **Multi-dimension JOINs**: Self-join `event_dimensions` to break down by 2-3
  dimensions simultaneously
- **SQLite/Turso friendly**: No JSON1 extension dependency
- **Schema-free**: Apps send any dimensions without migration
- **Tradeoff**: More rows and JOINs, mitigated by rollup tables for dashboard queries

### Multi-Dimension Query Example

"Which versions of which plugins succeed vs fail?"

```sql
SELECT
  d1.dim_value AS plugin_name,
  d2.dim_value AS plugin_version,
  d3.dim_value AS plugin_state,
  COUNT(*) AS event_count
FROM events e
JOIN event_dimensions d1 ON e.id = d1.event_id AND d1.dim_key = 'plugin.name'
JOIN event_dimensions d2 ON e.id = d2.event_id AND d2.dim_key = 'plugin.version'
JOIN event_dimensions d3 ON e.id = d3.event_id AND d3.dim_key = 'plugin.status'
WHERE e.app_id = ?
  AND e.event_name = 'plugin_used'
  AND e.timestamp BETWEEN ? AND ?
GROUP BY d1.dim_value, d2.dim_value, d3.dim_value
ORDER BY event_count DESC;
```

Result:

```
plugin_name      | plugin_version | plugin_status | count
image-optimizer  | 2.1.0          | ok            | 1234
image-optimizer  | 2.1.0          | failed        | 23
image-optimizer  | 2.0.0          | ok            | 456
audio-normalizer | 1.0.0          | ok            | 890
audio-normalizer | 1.0.0          | failed        | 156
```

## Ingestion API

### Endpoint

```
POST /v1/events
Authorization: Bearer <api-key>
Content-Type: application/json
User-Agent: statsfactory-sdk-go/0.1.0 (tinct/0.1.27; linux; amd64)
```

### Request Body

```json
{
  "events": [
    {
      "event": "generate",
      "timestamp": "2026-03-14T10:30:00Z",
      "session_id": "abc123",
      "distinct_id": "install-sha256hex",
      "dimensions": {
        "input.plugin": "image",
        "input.ai": false,
        "generate.theme_type": "dark",
        "generate.seed_mode": "content",
        "generate.backend": "kmeans",
        "generate.extract_ambience": true,
        "generate.dual_theme": true,
        "generate.dry_run": false
      }
    },
    {
      "event": "plugin_used",
      "dimensions": {
        "plugin.name": "kitty",
        "plugin.version": "0.1.27",
        "plugin.external": false,
        "plugin.status": "ok"
      }
    }
  ]
}
```

### Design Choices

- **Batch endpoint**: Up to 25 events per request (reduces request count)
- **Dimensions are typed**: string, number, boolean auto-detected from JSON values
- **Optional fields**: `session_id`, `distinct_id`, `timestamp` (defaults to server time)
- **Server enrichment**: Geo, network, UA dimensions added automatically
- **Dimension key rules**: lowercase, dot-separated, max 64 chars, max 50 dimensions per event
- **Dimension value limits**: Max 256 chars for strings, standard JSON number range

### Response

```json
{
  "accepted": 2,
  "errors": []
}
```

## Dashboard Features

### Views

1. **Overview** - Event counts, unique sessions, top events (time-series)
2. **Event Explorer** - Select event -> see dimension keys -> pick dimensions to break down
3. **Dimension Matrix** - The killer feature: select 2-3 dimensions, see cross-tabulated
   pivot table with counts and stacked bar charts
4. **Session Timeline** - If `session_id` provided, show event sequence within a session
5. **Live Feed** - Recent events (polling, not WebSocket, to stay on free tier)
6. **App Management** - Create apps, generate/revoke app keys, configure geo precision
   and retention

### Dimension Matrix (Aptabase Cannot Do This)

The dashboard presents a UI where you:

1. Pick an event name (e.g., `plugin_used`)
2. Pick dimensions for **rows** (e.g., `plugin.name`)
3. Pick dimensions for **columns** (e.g., `plugin.status`)
4. Optionally add **filters** (e.g., `geo.country = NZ`)
5. See a pivot table with counts, plus a stacked bar chart

## Free Tier Budget

| Resource | Free Limit | Est. Usage (moderate, 1-2 apps) |
|----------|-----------|--------------------------------|
| CF Worker requests | 100K/day | ~10K events/day + ~500 dashboard = ~11K |
| CF Worker CPU | 10ms/request | Ingest ~2ms, query ~8ms |
| Turso storage | 5GB | ~1M events w/ dimensions ~ 500MB |
| Turso reads | 500M/month | ~15M/month at moderate use |
| Turso writes | 10M/month | ~3M/month (events + dims + rollups) |
| CF Access | 50 users | 1 admin user |

Headroom for 5-10 apps before hitting limits.

## SDK Strategy

**Go SDK** - Tinct is the immediate consumer. The SDK replaces Tinct's
existing custom Aptabase client (`internal/telemetry/`) with minimal changes.
Same batch-and-flush pattern, same async queue, new wire format.

**TypeScript SDK** - Zero-dependency client for browsers, Node.js, Bun, Deno,
and Cloudflare Workers. Mirrors the Go SDK API surface (`new StatsFactory(config)`
-> `.track()` / `.trackWithOptions()` -> `.flush()` -> `.close()`). Includes
browser-specific features: `sessionStorage` for session ID persistence, `fetch`
with `keepalive: true` on page unload. Dual ESM + CJS output via tsup.

The HTTP API is simple enough that any language can call it with a plain
HTTP POST. Pre-built SDKs just handle batching, session management, and the
User-Agent convention.

### Go SDK Design (matching Tinct's existing patterns)

```go
client := statsfactory.New(statsfactory.Config{
    AppKey:    "sf_live_xxxx",
    ClientName:    "tinct",
    ClientVersion: version.Version,
})
defer client.Close()

client.Track("generate", statsfactory.Dims{
    "input.plugin":             "image",
    "generate.theme_type":      "dark",
    "generate.extract_ambience": true,
})

client.Track("plugin_used", statsfactory.Dims{
    "plugin.name":     "kitty",
    "plugin.version":  "0.1.27",
    "plugin.external": false,
    "plugin.status":   "ok",
})

client.Flush(ctx)
```

## Project Structure

```
statsfactory/
+-- apps/
|   +-- worker/                  # Cloudflare Worker (Hono API + Astro dashboard)
|   |   +-- src/
|   |   |   +-- index.ts         # Hono entrypoint
|   |   |   +-- routes/
|   |   |   |   +-- ingest.ts    # POST /v1/events
|   |   |   |   +-- query.ts     # GET /v1/query
|   |   |   |   +-- manage.ts    # App/key management
|   |   |   +-- db/
|   |   |   |   +-- schema.ts    # SQL schema + migrations
|   |   |   |   +-- queries.ts   # Query builders
|   |   |   |   +-- rollups.ts   # Rollup aggregation
|   |   |   +-- middleware/
|   |   |   |   +-- auth.ts      # appKeyAuth (ingest) + cfAccessAuth (dashboard/query)
|   |   |   |   +-- enrich.ts    # Server-side geo/UA enrichment
|   |   |   |   +-- cors.ts
|   |   |   +-- lib/
|   |   |       +-- ulid.ts
|   |   |       +-- validation.ts
|   |   |       +-- ua-parser.ts # User-Agent parsing
|   |   +-- wrangler.toml
|   |   +-- package.json
|   |
|   +-- dashboard/               # Astro frontend
|       +-- src/
|       |   +-- pages/
|       |   |   +-- index.astro
|       |   |   +-- apps/
|       |   |   +-- events/
|       |   |   +-- matrix/      # Dimension matrix view
|       |   +-- components/
|       |   |   +-- charts/
|       |   |   +-- ui/
|       |   +-- layouts/
|       +-- astro.config.mjs
|       +-- package.json
|
+-- packages/
|   +-- sdk-go/                  # Go SDK (first priority)
|   +-- sdk-ts/                  # TypeScript SDK (zero-dep, ESM+CJS)
|   +-- shared/                  # Shared types, validation schemas
|
+-- turbo.json
+-- package.json
+-- plan.md                      # This file
```

## Decisions

### D1: Single Worker Deployment

Astro + Hono in one Cloudflare Worker. Astro is the entry point, Hono is
mounted for `/v1/*` API routes. Dashboard pages prerendered as static HTML,
React islands for interactive components.

### D2: Drizzle ORM

Use Drizzle ORM with `@libsql/client/web` for the database layer.

### D3: React Islands for Dashboard

Astro pages with React island components for interactive elements (charts,
dimension matrix, filters).

### D4: Cloudflare Access for Dashboard Auth

Dashboard and query API protected by Cloudflare Access (Zero Trust). Free for
up to 50 users. No custom auth code needed — anyone passing the CF Access policy
is a full admin.

**Auth model (two mechanisms):**

1. **Ingest routes** (`POST /v1/events`): `appKeyAuth` middleware validates
   `Bearer <sf_live_xxx>` token against the `app_keys` table. App keys are
   public keys embedded in client SDKs, used only for mapping events to apps.
   Multiple keys can map to the same app.

2. **Query + Management routes** (`GET /v1/query/*`, `/v1/apps/*`):
   `cfAccessAuth` middleware reads `Cf-Access-Authenticated-User-Email` header
   injected by CF Access proxy. In dev mode (no `CF_ACCESS_TEAM_DOMAIN` env var),
   the middleware bypasses and sets `dev@localhost`.

3. **Health + OpenAPI**: Unauthenticated.

**Key design decision:** Query routes require `app_id` as a query parameter
(since CF Access doesn't provide app context like an API key would).

### D5: Go SDK in Monorepo

Go SDK lives at `packages/sdk-go/` with its own `go.mod`. Module path:
`github.com/jmylchreest/statsfactory/packages/sdk-go`.

### D6: Configurable Data Retention Per App

Each app has a `retention_days` setting. Cron trigger handles cleanup.

## Implementation Phases

### Phase 1: Scaffolding + Ingestion API

Goal: Accept events from curl and store them in Turso.

- [x] Initialize turborepo + pnpm workspace
- [x] Scaffold Astro app with `@astrojs/cloudflare` adapter
- [x] Mount Hono at `/v1/*` within Astro
- [x] Drizzle schema for `apps`, `app_keys`, `events`, `event_dimensions`
- [x] Turso client setup (`@libsql/client/web`)
- [x] `POST /v1/events` - validate, generate ULID, insert events + dimensions
- [x] Server-side enrichment middleware (CF geo + UA parsing)
- [x] App key auth middleware (ingestion) + CF Access auth middleware (dashboard/query)
- [x] Seed: CLI/API to create first app + API key
- [x] `wrangler.toml` with Turso secrets
- [x] Test: `curl -X POST /v1/events` with sample payload

### Phase 2: Query API + Basic Dashboard

Goal: View ingested data in a browser.

- [x] Query API endpoints (events, dimensions, breakdown, matrix)
- [x] Dashboard: layout with nav (Astro + Tailwind)
- [x] Dashboard: overview page (event count time series, top events)
- [x] Dashboard: event explorer (pick event, see dimensions, breakdown)
- [x] Cloudflare Access setup for dashboard and query routes

### Phase 3: Dimension Matrix + Rollups

Goal: The killer feature works, dashboard is performant.

- [x] Dashboard: dimension matrix page (React island)
- [x] Rollup table population on ingestion (hourly/daily)
- [x] Query API uses rollups for time-series and single-dim breakdowns
- [x] Dashboard: live feed page (polling recent events)

### Phase 4: Go SDK + Example Integration

Goal: Go SDK is usable, with example code showing Tinct-like integration.

- [x] Go SDK: `Client` with batch queue, background worker, flush
- [x] Go SDK: `Dims` type, `Track()` method, `Close()`
- [x] Go SDK: Structured User-Agent header, session ID generation
- [x] Go SDK: Tests (batching, flush, HTTP mock)
- [x] `contrib/examples/go/`: Example showing Tinct-like telemetry usage
- [x] Test harness: local test that sends events and verifies ingestion

Note: Tinct migration to statsfactory is deferred. The `contrib/examples/go/`
code serves as a reference for when that happens.

### Phase 4b: TypeScript SDK

Goal: TypeScript SDK is usable in browsers and server-side runtimes.

- [x] Package scaffolding (`package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`)
- [x] Core implementation: `StatsFactory` class, batching, background flush, session ID
- [x] Browser features: `sessionStorage` persistence, `fetch` with `keepalive` on page unload
- [x] Wire format matches Go SDK exactly (`POST /v1/events`, `Authorization: Bearer <key>`)
- [x] Dual ESM + CJS + DTS build via tsup
- [x] Tests (30 tests: track, flush, batching, session, close, wire format, error handling)
- [x] README with usage, config, advanced features

### Phase 5: Polish + Operations

- [x] Dashboard: session timeline view
- [x] Dashboard: app management (create/delete apps, manage keys)
- [x] Dashboard: app settings (geo precision, retention days)
- [x] Data retention: scheduled cron trigger to delete expired events
- [x] Rate limiting on ingestion
- [x] Deploy documentation
