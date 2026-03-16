# statsfactory

**Free, privacy-first telemetry for open-source projects.**

Most analytics platforms are overkill (and expensive) for the kind of usage
data open-source maintainers actually need: which versions are people running,
what features get used, where do crashes happen? statsfactory gives you that
insight without costing a cent -- it deploys as a single Cloudflare Worker on
the **free tier** with D1 for storage. No servers to manage, no monthly bills,
no vendor lock-in.

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

Prerequisites: [bun](https://bun.sh), [just](https://just.systems)

```bash
git clone https://github.com/jmylchreest/statsfactory.git
cd statsfactory
just init
just run
```

This installs dependencies, applies the D1 schema to a local miniflare SQLite
database, seeds a test app with an ingest key, builds, and starts `wrangler dev`
at `http://localhost:8787`.

The seed output prints your app key (`sf_live_...`). Use it to send test events:

```bash
curl -X POST http://localhost:8787/v1/events \
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

## Sending Events

### Using an SDK

Official SDKs handle batching, background flushing, session IDs, and structured
User-Agent headers automatically:

- **TypeScript/JavaScript** (browser, Node, Bun, Deno, Workers):
  [`@statsfactory/sdk`](packages/sdk-ts/README.md)
- **Go**: [`statsfactory`](packages/sdk-go/README.md)

```ts
import { StatsFactory } from "@statsfactory/sdk";

const sf = new StatsFactory({
  serverUrl: "https://stats.example.com",
  appKey: "sf_live_xxxx",
  clientName: "myapp",
  clientVersion: "1.0.0",
});

sf.track("plugin_used", {
  "plugin.name": "kitty",
  "plugin.version": "0.1.27",
  "plugin.status": "ok",
});
```

### Using plain HTTP

No SDK required -- any HTTP client works. The full API is described by an
**OpenAPI 3.1 spec** available at:

```
GET /v1/doc
```

For example: `https://stats.example.com/v1/doc` -- you can feed this to any
OpenAPI-compatible tool (Swagger UI, code generators, Postman, etc.) to explore
and interact with the API.

#### Ingest endpoint

```
POST /v1/events
Authorization: Bearer <app-key>
Content-Type: application/json
```

**Request body:**

```json
{
  "events": [
    {
      "event": "page_view",
      "timestamp": "2026-03-14T10:30:00Z",
      "session_id": "optional-session-id",
      "distinct_id": "optional-user-id",
      "dimensions": {
        "page.path": "/home",
        "theme": "dark",
        "version": 2,
        "beta": true
      }
    }
  ]
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `event` | string | Yes | Lowercase alphanumeric + underscores, max 64 chars. Must start with a letter. |
| `timestamp` | string | No | ISO 8601. Defaults to server time if omitted. |
| `session_id` | string | No | Client-provided session identifier. |
| `distinct_id` | string | No | Client-provided user/install identifier. |
| `dimensions` | object | No | Key-value map. Keys: lowercase `a-z0-9_.`, max 64 chars. Values: string (max 256 chars), number, or boolean. Max 10 user-provided dimensions per event. |

Up to 25 events per request. Valid events are accepted even if others in the
batch fail validation (partial acceptance).

**Response:**

```json
{
  "accepted": 1,
  "errors": []
}
```

Errors include an `index` field identifying which event failed and a `message`
explaining why.

#### Minimal curl example

```bash
curl -X POST https://stats.example.com/v1/events \
  -H "Authorization: Bearer sf_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"events": [{"event": "app_started"}]}'
```

#### User-Agent convention

If you're building your own client, set a structured `User-Agent` header so the
server can extract SDK/client enrichment dimensions automatically:

```
statsfactory-sdk-<lang>/<sdk-version> (<client-name>/<client-version>; <os>; <arch>)
```

For example: `statsfactory-sdk-go/0.1.0 (tinct/0.1.27; linux; amd64)`. This
produces enrichment dimensions like `sdk.name`, `sdk.version`, `client.name`,
`client.version`, `client.os`, and `client.arch`. Browser User-Agent strings
are also parsed for `client.browser`, `client.os`, and `client.device_type`.

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

### Prerequisites

Before deploying, you'll need:

**Cloudflare setup:**

1. **Cloudflare account** -- [sign up free](https://dash.cloudflare.com/sign-up).
2. **Domain on Cloudflare** -- a domain using Cloudflare nameservers. You can
   [register a new domain](https://www.cloudflare.com/products/registrar/)
   or [add an existing one](https://developers.cloudflare.com/fundamentals/setup/manage-domains/add-site/).
3. **Zero Trust team** -- set up a [Cloudflare Zero Trust](https://one.dash.cloudflare.com/)
   organization (free for up to 50 users). Under Settings > Authentication, add
   at least one identity provider (Google, GitHub, one-time PIN, etc.).
4. **API token** -- create a [Custom API Token](https://dash.cloudflare.com/profile/api-tokens)
   (Create Custom Token) with these settings:
   - **Permissions:**
     - Account | D1 | Edit
     - Account | Worker Scripts | Edit
     - Zone | Access: Apps and Policies | Edit
   - **Zone Resources:** Include | Specific zone | *your domain*
   
   Export it as `CLOUDFLARE_API_TOKEN` or paste it when prompted during install.

**Local tooling:**

- [bun](https://bun.sh) -- everything else is installed automatically

### Deploy script

```bash
./deploy.sh install    # Create D1, configure domain + Access, build, deploy
./deploy.sh upgrade    # Apply new migrations, rebuild, redeploy
./deploy.sh destroy    # Tear down worker, D1 database, and Access config
```

The install script handles `bun install` and `wrangler login` automatically,
then prompts for everything interactively. To skip prompts, set environment
variables:

```bash
export CLOUDFLARE_API_TOKEN=xxxx
export CF_ACCESS_TEAM_DOMAIN=myteam         # <team>.cloudflareaccess.com
export STATSFACTORY_DOMAIN=stats.example.com
./deploy.sh install
```

See [docs/deploy.md](docs/deploy.md) for manual deployment steps and CI/CD setup.

## Configuration

All configuration is via environment variables. For local dev these live in
`apps/web/.dev.vars` (created automatically by `just setup-env`).

| Variable | Required | Description |
|----------|----------|-------------|
| `DB` | Yes | Cloudflare D1 binding (set via `wrangler.toml`, not a secret) |
| `CF_ACCESS_TEAM_DOMAIN` | Production | Cloudflare Access team domain. Required for production dashboard auth. |
| `STATSFACTORY_DEV` | Dev only | Set to `1` to bypass dashboard auth in local development. |

For production, set secrets as Cloudflare Worker secrets:

```bash
wrangler secret put CF_ACCESS_TEAM_DOMAIN
```

## Authentication

Two separate auth mechanisms:

- **Ingest** (`POST /v1/events`): Bearer token using an app key (`sf_live_...`).
  App keys are public, embedded in client SDKs, and map events to apps.
- **Dashboard & Query API**: Cloudflare Access (Zero Trust). In local dev this
  is bypassed automatically when `STATSFACTORY_DEV=1`.

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
($5/month) removes all daily caps.

**Do I need Cloudflare Access for local development?**
No. When `STATSFACTORY_DEV=1` is set in `.dev.vars`, dashboard auth is bypassed
with a `dev@localhost` identity.

## License

[MIT](LICENSE)
