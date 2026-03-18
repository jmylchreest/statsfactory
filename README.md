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
- **Multi-dimension analytics** -- cross-tabulate any combination of dimensions
  in one view (e.g. `plugin.name` x `plugin.version` x `status`).
- **Drop-in SDKs** -- lightweight clients for
  [TypeScript/JavaScript](packages/sdk-ts/README.md) and
  [Go](packages/sdk-go/README.md), or use plain HTTP POST.
- **Self-hosted, your data** -- deploy to your own Cloudflare account in
  minutes. You own the data, full stop.

## Quick Start

Prerequisites: [bun](https://bun.sh), a Cloudflare account with a domain.
See [docs/deploy.md](docs/deploy.md) for full prerequisites and details.

```bash
git clone https://github.com/jmylchreest/statsfactory.git
cd statsfactory
./deploy.sh install
```

The script handles everything interactively: D1 database, domain, Cloudflare
Access, build, and deploy. Then create an app and key in the dashboard and
start sending events:

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

No SDK? The full API is described by an OpenAPI 3.1 spec at `GET /v1/doc` on
your deployed instance, or use curl directly:

```bash
curl -X POST https://stats.example.com/v1/events \
  -H "Authorization: Bearer sf_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"events": [{"event": "app_started"}]}'
```

Other deploy commands:

```bash
./deploy.sh upgrade              # Apply migrations, rebuild, redeploy
./deploy.sh reconfigure-access   # Change who can access the dashboard
./deploy.sh destroy              # Tear everything down
```

## Local Development

Prerequisites: [bun](https://bun.sh), [just](https://just.systems)

```bash
just init   # install deps, apply schema, seed test data
just run    # start wrangler dev at http://localhost:8787
```

The seed output prints a test app key (`sf_live_...`). Auth is bypassed
automatically in local dev.

## Project Structure

```
apps/web/          Cloudflare Worker (Hono API + Astro dashboard)
packages/sdk-go/   Go SDK
packages/sdk-ts/   TypeScript SDK (browser, Node, Bun, Deno, Workers)
docs/              Deployment and operations docs
```

## FAQ

**How is this different from Aptabase / PostHog / Plausible?**
Purpose-built for the open-source use case: deploy once for free, send events
with typed dimension maps, and cross-tabulate any combination of dimensions.

**What does "free" actually mean?**
Cloudflare Workers free tier: 100K requests/day. D1 free tier: 5GB storage,
5M reads/day, 100K writes/day. Enough for thousands of telemetry events per
day. The Workers paid plan ($5/month) removes all daily caps.

## License

[MIT](LICENSE)
