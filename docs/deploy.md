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

### 1. Create the database (D1)

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

> **Alternative: Turso** — If you prefer Turso (portable, no vendor lock-in),
> skip the D1 steps and see [Using Turso instead](#alternative-turso) below.

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

**`ci.yml`** — runs on push to `main` and PRs:
- Builds with bun
- On tagged releases (`v*`), packages a release bundle (tarball + zip) and publishes to GitHub Releases

**`deploy.yml`** — auto-deploy on push to `main`:
- Applies D1 migrations remotely
- Deploys the worker

Required repository secrets for `deploy.yml`:
- `CLOUDFLARE_API_TOKEN` — API token with Workers + D1 permissions
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID

The `wrangler.toml` must have the real `database_id` committed for auto-deploy to work.

## Data retention

A cron trigger runs daily at 03:00 UTC, deleting events older than each app's
`retention_days` (default 90). Already configured in `wrangler.toml`:

```toml
[triggers]
crons = ["0 3 * * *"]
```

---

## Alternative: Turso

If you prefer [Turso](https://turso.tech) over D1 (e.g. for portability or
local-first sync), leave the `[[d1_databases]]` section commented out and
set Turso credentials as secrets instead:

```bash
turso db create statsfactory
turso db show statsfactory --url     # libsql://statsfactory-xxx.turso.io
turso db tokens create statsfactory  # your auth token
```

Push the schema:

```bash
cd apps/web
TURSO_DATABASE_URL=libsql://statsfactory-xxx.turso.io \
TURSO_AUTH_TOKEN=your-token \
bun run db:push
```

Set secrets:

```bash
wrangler secret put TURSO_DATABASE_URL    # paste libsql:// URL
wrangler secret put TURSO_AUTH_TOKEN      # paste token
wrangler secret put CF_ACCESS_TEAM_DOMAIN
bun run build && wrangler deploy
```

The worker auto-detects which backend to use: D1 binding takes priority,
falling back to Turso if `TURSO_DATABASE_URL` is set.

## Cost comparison: D1 vs Turso

Both are SQLite-based. D1 is recommended for most deployments.

### Free tier

|  | D1 Free (Workers Free) | Turso Free |
|--|------------------------|------------|
| Rows read | 5 M/day (~150 M/mo) | 500 M/mo |
| Rows written | 100 K/day (~3 M/mo) | 10 M/mo |
| Storage | 5 GB | 5 GB |

### Paid tier ($5/mo)

|  | D1 (Workers Paid) | Turso Developer |
|--|-------------------|-----------------|
| Rows read | 25 B/mo, then $1/B | 2.5 B/mo, then $1/B |
| Rows written | 50 M/mo, then $1/M | 25 M/mo, then $1/M |
| Storage | 5 GB, then $0.75/GB | 9 GB, then $0.75/GB |

D1 paid gives **10x reads** and **2x writes** for the same price.

### Trade-offs

| | D1 | Turso |
|--|----|----|
| Latency | Zero (colocated with Worker) | HTTP round-trip to nearest edge PoP |
| Portability | Cloudflare-only | Self-hostable, standard libSQL protocol |
| Lock-in | High | Low |
