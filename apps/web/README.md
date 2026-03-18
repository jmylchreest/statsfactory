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

- `DB` -- D1 database binding (configured in `wrangler.dev.toml` for local dev)
- `STATSFACTORY_DEV` -- set to `1` for local dev (bypasses dashboard auth)
- `CF_ACCESS_TEAM_DOMAIN` -- (production) enables Cloudflare Access auth

## Production Deployment

Use the deploy script -- it handles everything via the Cloudflare TypeScript SDK
(no wrangler needed for production):

```bash
./deploy.sh install              # Create D1, configure domain + Access, build, deploy
./deploy.sh upgrade              # Apply new migrations, rebuild, redeploy
./deploy.sh destroy              # Tear down worker, D1 database, and Access config
```

See [`docs/deploy.md`](../../docs/deploy.md) for full details, including
prerequisites, API token setup, and CI/CD configuration.

### Custom domain

The deploy script configures custom domains automatically via the Cloudflare SDK.
Set `STATSFACTORY_DOMAIN` or enter it when prompted during `./deploy.sh install`.

### Data retention cron

A Cloudflare Cron Trigger runs daily at 03:00 UTC to delete events older than
each app's configured `retention_days`. The deploy script sets this up
automatically. For local dev, it's configured in `wrangler.dev.toml`:

```toml
[triggers]
crons = ["0 3 * * *"]
```

To test locally: `wrangler dev --test-scheduled`, then `curl http://localhost:8787/__scheduled`.

### Cost estimate (free tier)

| Service | Free tier limit | Typical usage (5-10 apps) |
|---------|----------------|--------------------------|
| CF Workers | 100 K requests/day | Well within limits |
| D1 | 5 M reads/day, 100 K writes/day, 5 GB | Comfortable |
| CF Access | 50 users | More than enough |

For heavier usage, the CF Workers paid plan ($5/mo) provides 10 M requests/mo
and D1 paid gives 25 B reads + 50 M writes/mo.
