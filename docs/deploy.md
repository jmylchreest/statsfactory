# Deploy

## Prerequisites

**Cloudflare setup:**

1. **Cloudflare account** -- [sign up free](https://dash.cloudflare.com/sign-up).
2. **Domain on Cloudflare** -- a domain using Cloudflare nameservers. You can
   [register a new domain](https://www.cloudflare.com/products/registrar/)
   or [add an existing one](https://developers.cloudflare.com/fundamentals/setup/manage-domains/add-site/).
3. **Zero Trust team** -- set up a
   [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) organization
   (free for up to 50 users). Under Settings > Authentication, add at least one
   identity provider (Google, GitHub, one-time PIN, etc.).
4. **Access Group** (recommended) -- restricts dashboard access to specific
   people. In the [Zero Trust dashboard](https://one.dash.cloudflare.com/),
   go to Access > Access Groups > Add a Group:
   - **Group name:** e.g. `Team` or your org name
   - **Include rule:** select "Emails" and add the email addresses of people
     who should have access (or use "Emails ending in" for a whole domain)
   - Save the group. The deploy script will reference it during install.
5. **API token** -- create a
   [Custom API Token](https://dash.cloudflare.com/profile/api-tokens)
   (Create Custom Token) with these settings:
   - **Permissions:**
     - Account | D1 | Edit
     - Account | Worker Scripts | Edit
     - Account | Access: Organizations, Identity Providers, and Groups | Read
     - Zone | Workers Routes | Edit
     - Zone | DNS | Edit
     - Zone | Access: Apps and Policies | Edit
   - **Zone Resources:** Include | Specific zone | *your domain*

**Local tooling:**

- [bun](https://bun.sh) -- everything else is installed automatically

## Quick start (deploy script)

The fastest way to deploy. Only requires `bun` installed -- the script handles
`bun install` automatically. Deploys use the Cloudflare TypeScript SDK directly
(no wrangler needed at deploy time).

```bash
./deploy.sh install              # Create D1, configure domain + Access, build, deploy
./deploy.sh upgrade              # Apply new migrations, rebuild, redeploy
./deploy.sh reconfigure-access   # Change the Access policy without rebuild/redeploy
./deploy.sh destroy              # Tear down worker, D1 database, and Access config
./deploy.sh logs                 # Stream real-time worker logs (Ctrl-C to stop)
```

The install script prompts for everything interactively, or set environment
variables to skip prompts:

```bash
export CLOUDFLARE_API_TOKEN=xxxx
export CF_ACCESS_TEAM_DOMAIN=myteam         # <team>.cloudflareaccess.com
export STATSFACTORY_DOMAIN=stats.example.com
./deploy.sh install
```

The script is idempotent -- safe to re-run if interrupted.

### Multiple instances

Use `--name` (or `STATSFACTORY_NAME` env var) to deploy independent instances
side by side. Each gets its own worker, D1 database, Access apps, and deploy
config file:

```bash
./deploy.sh install --name prod    # worker: statsfactory-prod, DB: statsfactory-prod
./deploy.sh install --name staging # worker: statsfactory-staging, DB: statsfactory-staging

./deploy.sh upgrade --name prod
./deploy.sh destroy --name staging
```

Without `--name` the default name is `statsfactory` (no suffix).

## Manual deploy

The deploy script (`scripts/deploy.ts`) is the only supported deploy method. It
uses the Cloudflare TypeScript SDK for all operations -- no wrangler needed.

If you need to do things manually (e.g. creating a D1 database for testing),
you can use [wrangler](https://developers.cloudflare.com/workers/wrangler/):

```bash
wrangler d1 create statsfactory
wrangler d1 migrations apply statsfactory --remote
```

However, the deploy script handles all of this automatically.

### 4. Cloudflare Access (Zero Trust)

> **Note:** The deploy script (`./deploy.sh install`) configures Access
> automatically. These manual steps are only needed if you're not using
> the script.

Protects the dashboard and query API. Free for up to 50 users.

1. [Zero Trust dashboard](https://one.dash.cloudflare.com) > Settings > Authentication -- add an identity provider (Google, GitHub, one-time PIN)
2. Access > Applications > Add application > **Self-hosted**
3. Set domain to your custom domain (e.g. `stats.example.com`)
4. Add an **Allow** policy (e.g. emails ending in `@yourcompany.com`)
5. Create additional **Self-hosted** apps for public endpoints with **Bypass** policies:
   - `stats.example.com/v1/events` (SDK ingest)
   - `stats.example.com/v1/health` (health check)
   - `stats.example.com/v1/doc` (API docs)

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
- Applies D1 migrations via Cloudflare SDK
- Builds and deploys the worker (no wrangler)

Required repository secrets for `deploy.yml`:
- `CLOUDFLARE_API_TOKEN` -- API token with Workers + D1 permissions

Required repository variables for `deploy.yml`:
- `STATSFACTORY_DOMAIN` -- custom domain (e.g. `stats.example.com`)
- `STATSFACTORY_NAME` -- instance name (e.g. `prod`)

## Data retention

A cron trigger runs daily at 03:00 UTC, deleting events older than each app's
`retention_days` (default 90). The deploy script configures this automatically.
For local dev, it's configured in `wrangler.dev.toml`:

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
