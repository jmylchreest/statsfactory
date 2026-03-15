# statsfactory TypeScript SDK

TypeScript client for the statsfactory analytics API. Zero dependencies. Works
in browsers, Node.js, Bun, Deno, and Cloudflare Workers.

Handles batching (max 25 events/request), background flushing, structured
User-Agent headers, session ID generation, and page unload flushing in browsers.

## Install

```bash
npm install @statsfactory/sdk
# or
bun add @statsfactory/sdk
```

## Usage

```ts
import { StatsFactory } from "@statsfactory/sdk";

const sf = new StatsFactory({
  serverUrl: "https://stats.example.com",
  appKey: "sf_live_xxxx",
  clientName: "myapp",
  clientVersion: "1.0.0",
});

sf.track("page_view", { "page.path": "/home", theme: "dark" });

// Events flush automatically every 30s and on close.
// Force an immediate flush:
await sf.flush();

// Flush remaining events and stop the background timer:
await sf.close();
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `serverUrl` | (required) | statsfactory API base URL, no trailing slash |
| `appKey` | (required) | App key (`sf_live_...`) |
| `clientName` | — | Your app name (used in User-Agent) |
| `clientVersion` | — | Your app version (used in User-Agent) |
| `flushInterval` | `30000` | Background flush interval in ms. `0` to disable |
| `sessionId` | auto-generated | Override session ID |
| `useBeacon` | `true` | Use `fetch` with `keepalive` on page unload (browser only) |
| `onError` | — | Callback for background flush errors |
| `fetch` | `globalThis.fetch` | Custom fetch implementation |

## Dimensions

Dimensions are `Record<string, string | number | boolean>`. Use dot-notation
to group related dimensions:

```ts
sf.track("plugin_used", {
  "plugin.name": "kitty",
  "plugin.version": "0.1.27",
  "plugin.external": false,
  "plugin.status": "ok",
});
```

## Advanced

Override timestamp, session ID, or distinct ID per event:

```ts
sf.trackWithOptions("event_name", { key: "value" }, {
  timestamp: new Date(),        // or ISO 8601 string
  sessionId: "custom-session",
  distinctId: "user-hash",
});
```

### Browser behaviour

In browsers, the SDK:

- Persists the session ID in `sessionStorage` across page navigations within
  the same tab.
- On page unload (`visibilitychange` / `pagehide`), flushes remaining events
  via `fetch` with `keepalive: true` so requests survive page navigation.

### Error handling

- `flush()` rejects on server errors so you can catch them.
- Background flush errors (from the interval timer) are routed to the `onError`
  callback instead of throwing.

```ts
const sf = new StatsFactory({
  serverUrl: "https://stats.example.com",
  appKey: "sf_live_xxxx",
  onError: (err) => console.warn("Flush failed:", err.message),
});
```

## Testing

```bash
bun run test
```

## Build

```bash
bun run build
```

Produces ESM (`dist/index.js`), CJS (`dist/index.cjs`), and TypeScript
declarations (`dist/index.d.ts`).
