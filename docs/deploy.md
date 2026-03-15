# Deploy

## Quick start (deploy script)

The fastest way to deploy. Requires [wrangler](https://developers.cloudflare.com/workers/wrangler/) authenticated (`wrangler login`).

```bash
./deploy.sh install    # First time: create D1, set secrets, build, deploy
./deploy.sh upgrade    # Apply new migrations, rebuild, redeploy
./deploy.sh destroy    # Tear down worker + D1 database
```

`install` prompts for `CF_ACCESS_TEAM_DOMAIN` interactively (or pass it via env var).

## Manual deploy

### Prerequisites

- [Cloudflare](https://dash.cloudflare.com) account (free tier works)
- [bun](https://bun.sh) and [wrangler](https://developers.cloudflare.com/workers/wrangler/) installed

### 1. Create the D1 database

```bash
wrangler d1 create statsfactory
```

Copy the `database_id` from the output into `apps/web/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "statsfactory"
database_id = "<paste-id>"
```

Apply the schema:

```bash
cd apps/web && wrangler d1 migrations apply statsfactory --remote
```

### 2. Set secrets and deploy

```bash
wrangler secret put CF_ACCESS_TEAM_DOMAIN  # your-team (from your-team.cloudflareaccess.com)
cd apps/web && bun run build && wrangler deploy
```

The `wrangler.toml` is already configured -- no other edits needed. Wrangler
prints your worker URL: `https://statsfactory.<account>.workers.dev`.

### 3. Custom domain

Your domain must use Cloudflare nameservers. Then:

**Dashboard:** Workers & Pages > statsfactory > Settings > Domains & Routes > Add > Custom Domain

**Or wrangler.toml:**

```toml
routes = [
  { pattern = "stats.example.com/*", zone_name = "example.com" }
]
```

Cloudflare provisions DNS and TLS automatically.

### 4. Cloudflare Access (Zero Trust)

Protects the dashboard and query API. Free for up to 50 users.

1. [Zero Trust dashboard](https://one.dash.cloudflare.com) > Settings > Authentication -- add an identity provider (Google, GitHub, one-time PIN)
2. Access > Applications > Add application > **Self-hosted**
3. Set domain to your worker URL or custom domain
4. Add an **Allow** policy (e.g. emails ending in `@yourcompany.com`)

The `CF_ACCESS_TEAM_DOMAIN` secret tells the worker to validate the
`Cf-Access-Jwt-Assertion` header. Without it, the worker rejects all
dashboard/query requests with 503 (fail-closed). Ingest (`POST /v1/events`)
uses app key auth and is unaffected.

### 5. Create an app and key

Via the dashboard UI (Manage Apps page), or:

```bash
curl -X POST https://stats.example.com/v1/apps \
  -H "Content-Type: application/json" \
  -d '{"name": "My App"}'

curl -X POST https://stats.example.com/v1/apps/APP_ID/keys \
  -H "Content-Type: application/json" \
  -d '{"name": "Production"}'
```

## CI/CD

### GitHub Actions (included)

Two workflows in `.github/workflows/`:

**`ci.yml`** -- runs on push to `main` and PRs:
- Builds with bun
- On tagged releases (`v*`), packages a release bundle (tarball + zip) and publishes to GitHub Releases

**`deploy.yml`** -- auto-deploy on push to `main`:
- Applies D1 migrations remotely
- Deploys the worker

Required repository secrets for `deploy.yml`:
- `CLOUDFLARE_API_TOKEN` -- API token with Workers + D1 permissions
- `CLOUDFLARE_ACCOUNT_ID` -- your Cloudflare account ID

The `wrangler.toml` must have the real `database_id` committed for auto-deploy to work.

## Data retention

A cron trigger runs daily at 03:00 UTC, deleting events older than each app's
`retention_days` (default 90). Already configured in `wrangler.toml`:

```toml
[triggers]
crons = ["0 3 * * *"]
```

## Cost estimate

### D1 Free tier (Workers Free)

| Resource | Limit |
|----------|-------|
| Rows read | 5 M/day (~150 M/mo) |
| Rows written | 100 K/day (~3 M/mo) |
| Storage | 5 GB |
| Worker requests | 100 K/day |

### D1 Paid tier (Workers Paid $5/mo)

| Resource | Included | Overage |
|----------|----------|---------|
| Rows read | 25 B/mo | $0.001/M |
| Rows written | 50 M/mo | $1.00/M |
| Storage | 5 GB | $0.75/GB |
| Worker requests | 10 M/mo | $0.30/M |
