# statsfactory web

Cloudflare Worker running the Hono API and Astro dashboard.

## Local Development

Prerequisites: [bun](https://bun.sh), [just](https://just.systems)

```bash
just init    # install deps, apply D1 schema, seed test app
just run     # build + wrangler dev on port 8787
```

`just init` does everything in one command:

1. Installs dependencies (`bun install`)
2. Creates `.dev.vars` from the example template
3. Applies the D1 migration to a local miniflare SQLite database
4. Seeds a test app and prints the ingest key

### Running Components Individually

```bash
just install       # bun install
just setup-env     # create .dev.vars from example
just setup-db      # apply D1 migrations locally
just setup-seed    # seed test app + API key
just build         # astro build
just run           # build + wrangler dev
```

## Testing

```bash
just test          # Run once
just test-watch    # Watch mode
```

Tests use Miniflare for D1 integration tests (in-memory SQLite, no external
processes needed).

## API Endpoints

### Ingestion (app key auth)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/events` | Ingest events (batch, up to 25) |

### Query (Cloudflare Access / dev bypass)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/query/events` | Event counts and top events |
| `GET` | `/v1/query/dimensions` | Dimension keys for an event |
| `GET` | `/v1/query/breakdown` | Single-dimension breakdown |
| `GET` | `/v1/query/matrix` | Multi-dimension cross-tabulation |

### Management (Cloudflare Access / dev bypass)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/apps` | List apps |
| `POST` | `/v1/apps` | Create app |
| `PATCH` | `/v1/apps/:id` | Update app settings (name, geo, retention) |
| `DELETE` | `/v1/apps/:id` | Delete app and all its data |
| `GET` | `/v1/apps/:id/keys` | List app keys |
| `POST` | `/v1/apps/:id/keys` | Create app key |
| `POST` | `/v1/apps/:id/keys/:keyId/revoke` | Revoke an app key |

### Cron (Cloudflare Access / dev bypass)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/cron/retention` | Run data retention cleanup |

### Other

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/health` | Health check |
| `GET` | `/v1/doc` | OpenAPI spec |

All query and management endpoints require `app_id` as a query parameter.

## Environment Variables

See [`.dev.vars.example`](.dev.vars.example) for documentation. Key variables:

- `DB` -- D1 database binding (configured in `wrangler.toml`)
- `STATSFACTORY_DEV` -- set to `1` for local dev (bypasses dashboard auth)
- `CF_ACCESS_TEAM_DOMAIN` -- (production) enables Cloudflare Access auth

## Production Deployment

### Prerequisites

- A [Cloudflare](https://dash.cloudflare.com) account (free tier works)
- [bun](https://bun.sh) and [wrangler](https://developers.cloudflare.com/workers/wrangler/) installed
- (Optional) A custom domain pointed at Cloudflare

### 1. Create the D1 database

```bash
wrangler d1 create statsfactory
```

Copy the `database_id` from the output into `apps/web/wrangler.toml` (replacing `"local-dev"`).

### 2. Apply the schema

```bash
cd apps/web && wrangler d1 migrations apply statsfactory --remote
```

### 3. Set Cloudflare Worker secrets

```bash
wrangler secret put CF_ACCESS_TEAM_DOMAIN  # e.g. your-team.cloudflareaccess.com
```

### 4. Deploy

```bash
bun run build
wrangler deploy
```

Wrangler will print the worker URL (e.g. `https://statsfactory.your-account.workers.dev`).

### 5. Set up Cloudflare Access (Zero Trust)

The dashboard and query API are protected by
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/).
This is free for up to 50 users.

1. Go to **Cloudflare Zero Trust** dashboard > **Access** > **Applications**
2. Click **Add an application** > **Self-hosted**
3. Set the **Application domain** to your worker URL or custom domain
4. Add an **Allow** policy (e.g. email ending in `@yourcompany.com`)
5. Save -- Cloudflare Access now handles login, MFA, and session cookies

The `CF_ACCESS_TEAM_DOMAIN` secret (e.g. `your-team.cloudflareaccess.com`) tells
the auth middleware to validate the `Cf-Access-Authenticated-User-Email` header
that Access sets automatically on every request.

### 6. Create your first app and key

```bash
# Create an app
curl -X POST https://your-worker.workers.dev/v1/apps \
  -H "Content-Type: application/json" \
  -d '{"name": "My App"}'
# -> {"id":"01J1ABCDE...","name":"My App"}

# Create an ingest key
curl -X POST https://your-worker.workers.dev/v1/apps/01J1ABCDE.../keys \
  -H "Content-Type: application/json" \
  -d '{"name": "Production Key"}'
# -> {"id":"...","key":"sf_live_xxx","key_prefix":"sf_live_","name":"Production Key","note":"..."}
```

Or use the **Manage Apps** page in the dashboard to create apps and keys via the UI.

### 7. Data retention cron

A Cloudflare Cron Trigger runs daily at 03:00 UTC to delete events older than
each app's configured `retention_days`. This is configured in `wrangler.toml`:

```toml
[triggers]
crons = ["0 3 * * *"]
```

To test locally: `wrangler dev --test-scheduled`, then `curl http://localhost:8787/__scheduled`.

You can also trigger retention manually via the API:

```bash
curl -X POST https://your-worker.workers.dev/v1/cron/retention
```

### Custom domain

Add a custom domain via **Cloudflare Workers** > **Settings** > **Triggers** >
**Custom Domains**, or use a `routes` block in `wrangler.toml`:

```toml
routes = [
  { pattern = "analytics.example.com/*", zone_name = "example.com" }
]
```

### Cost estimate (free tier)

| Service | Free tier limit | Typical usage (5-10 apps) |
|---------|----------------|--------------------------|
| CF Workers | 100 K requests/day | Well within limits |
| D1 | 5 M reads/day, 100 K writes/day, 5 GB | Comfortable |
| CF Access | 50 users | More than enough |

For heavier usage, the CF Workers paid plan ($5/mo) provides 10 M requests/mo
and D1 paid gives 25 B reads + 50 M writes/mo.
