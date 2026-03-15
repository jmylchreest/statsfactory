# statsfactory

**Free, privacy-first telemetry for open-source projects.**

Most analytics platforms are overkill (and expensive) for the kind of usage
data open-source maintainers actually need: which versions are people running,
what features get used, where do crashes happen? statsfactory gives you that
insight without costing a cent -- it deploys as a single Cloudflare Worker on
the **free tier** with D1 (or Turso) for storage. No servers to manage, no
monthly bills, no vendor lock-in.

- **Zero cost** -- runs entirely within Cloudflare's free tier (Workers + D1).
  Comfortable for thousands of events per day across multiple projects.
- **Privacy-first** -- no cookies, no fingerprinting, no PII stored. Events
  carry only the dimensions you explicitly send.
- **Multi-dimension analytics** -- go beyond flat property breakdowns. Cross-
  tabulate any combination of dimensions in one view (e.g. `plugin.name` x
  `plugin.version` x `status`).
- **Drop-in SDKs** -- lightweight clients for TypeScript/JavaScript (browser,
  Node, Bun, Deno, Workers) and Go, or use plain HTTP POST.
- **Automatic enrichment** -- geo (country, region, city) and device context
  derived from Cloudflare request metadata at ingest time, at no extra cost.
- **Self-hosted, your data** -- deploy to your own Cloudflare account in
  minutes. You own the data, full stop.

## Quick Start

Prerequisites: [bun](https://bun.sh)

```bash
git clone https://github.com/jmylchreest/statsfactory.git
cd statsfactory
bun install
cd apps/web
bun run setup:local
```

This pushes the schema to a local SQLite file, seeds a test app with an ingest
key, starts a local libSQL HTTP server, and opens the Astro dev server at
`http://localhost:4321`.

The seed output prints your app key (`sf_live_...`). Use it to send test events:

```bash
curl -X POST http://localhost:4321/v1/events \
  -H "Authorization: Bearer sf_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [{
      "event": "page_view",
      "dimensions": {
        "page.path": "/home",
        "theme": "dark"
      }
    }]
  }'
```

## Project Structure

```
statsfactory/
  apps/web/          Cloudflare Worker (Hono API + Astro dashboard)
  packages/sdk-go/   Go SDK
  packages/sdk-ts/   TypeScript SDK (browser, Node, Bun, Deno, Workers)
  contrib/examples/  Example integrations
  plan.md            Architecture and design document
```

See sub-READMEs for details:

- [apps/web/](apps/web/README.md) -- Web app development and API reference
- [packages/sdk-go/](packages/sdk-go/README.md) -- Go SDK usage
- [packages/sdk-ts/](packages/sdk-ts/README.md) -- TypeScript SDK usage

## Deploy

See [docs/deploy.md](docs/deploy.md) for production deployment (D1 or Turso,
Cloudflare Workers, custom domain, Zero Trust auth). The `wrangler.toml` is
ready to go -- create a D1 database, set one secret, and run `wrangler deploy`.

## Configuration

All configuration is via environment variables. For local dev these live in
`apps/web/.dev.vars` (created automatically by `setup:local`).

| Variable | Required | Description |
|----------|----------|-------------|
| `DB` | D1 | Cloudflare D1 binding (set via `wrangler.toml`, not a secret) |
| `TURSO_DATABASE_URL` | Turso | Turso/libSQL connection URL (alternative to D1) |
| `TURSO_AUTH_TOKEN` | Turso | Turso auth token (`unused` for local dev) |
| `CF_ACCESS_TEAM_DOMAIN` | No | Cloudflare Access team domain. When absent, dashboard auth is bypassed (dev mode). |

One of `DB` or `TURSO_DATABASE_URL` must be configured. If both are present,
D1 takes priority.

For production, set secrets as Cloudflare Worker secrets:

```bash
# D1 users only need:
wrangler secret put CF_ACCESS_TEAM_DOMAIN

# Turso users also need:
wrangler secret put TURSO_DATABASE_URL
wrangler secret put TURSO_AUTH_TOKEN
```

## Authentication

Two separate auth mechanisms:

- **Ingest** (`POST /v1/events`): Bearer token using an app key (`sf_live_...`).
  App keys are public, embedded in client SDKs, and map events to apps.
- **Dashboard & Query API**: Cloudflare Access (Zero Trust). In local dev this
  is bypassed automatically.

## FAQ

**How is this different from Aptabase / PostHog / Plausible?**
Aptabase has a flat property model with single-dimension breakdowns.
PostHog and Plausible are full-featured but require hosting infrastructure or
paid plans. statsfactory is purpose-built for the open-source use case: deploy
once for free, send events with typed dimension maps, and cross-tabulate any
combination of those dimensions (e.g., `plugin.name` x `plugin.version` x
`plugin.status`).

**What does "free" actually mean?**
Cloudflare Workers free tier gives you 100K requests/day and D1 gives you 5GB
storage with 5M reads/day and 100K writes/day. That's enough for thousands of
telemetry events per day across multiple open-source projects -- more than most
OSS maintainers will ever need. If you outgrow it, the Workers paid plan
($5/month) removes all daily caps. Turso is also supported as an alternative
backend with its own generous free tier (500M reads, 10M writes/month).

**Do I need Cloudflare Access for local development?**
No. When `CF_ACCESS_TEAM_DOMAIN` is not set, dashboard auth is bypassed with a
`dev@localhost` identity.

**Can I use a database other than D1?**
Turso (or any libSQL-compatible database) is supported as an alternative.
Set `TURSO_DATABASE_URL` instead of the D1 binding. The local dev setup uses
a plain SQLite file served over HTTP via the Turso path.

## License

[MIT](LICENSE)
