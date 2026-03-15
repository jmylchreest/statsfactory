#!/usr/bin/env bun
/**
 * Send random test events to a local statsfactory instance.
 *
 * Usage:
 *   bun run scripts/send-events.ts <api_key> [options]
 *
 * Options:
 *   --port <n>        Server port (default: 8787)
 *   --count <n>       Number of events to send (default: random 2-10)
 *   --event <name>    Specific event name (default: random from pool)
 *   --session <id>    Specific session ID (default: random per-burst)
 */

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// First positional arg is the API key
const apiKey = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") === false && args.indexOf(a) === 0)
  ?? args.find((a) => !a.startsWith("--") && (args.indexOf(a) === 0 || !args[args.indexOf(a) - 1]?.startsWith("--")));

if (!apiKey || apiKey.startsWith("--")) {
  console.error("Usage: bun run scripts/send-events.ts <api_key> [--port 8787] [--count 5] [--event page_view] [--session sid]");
  process.exit(1);
}

const port = flag("port") ?? "8787";
const countArg = flag("count");
const eventArg = flag("event");
const sessionArg = flag("session");

// ── Event pool ──────────────────────────────────────────────────────

const EVENT_POOL: { event: string; dims: () => Record<string, string | number | boolean> }[] = [
  {
    event: "page_view",
    dims: () => {
      const pages = ["/", "/home", "/about", "/pricing", "/docs", "/blog", "/contact", "/dashboard", "/settings"];
      const page = pages[Math.floor(Math.random() * pages.length)];
      return {
        "page.path": page,
        "page.title": page === "/" ? "Home" : page.slice(1).charAt(0).toUpperCase() + page.slice(2),
        "page.referrer": Math.random() > 0.5 ? "https://google.com" : "",
      };
    },
  },
  {
    event: "click",
    dims: () => {
      const targets = ["signup_btn", "login_btn", "cta_hero", "nav_docs", "nav_pricing", "footer_link", "card_item"];
      return {
        "ui.target": targets[Math.floor(Math.random() * targets.length)],
        "ui.section": Math.random() > 0.5 ? "header" : "body",
      };
    },
  },
  {
    event: "form_submit",
    dims: () => {
      const forms = ["signup", "login", "contact", "newsletter", "feedback"];
      return {
        "form.name": forms[Math.floor(Math.random() * forms.length)],
        "form.success": Math.random() > 0.2,
      };
    },
  },
  {
    event: "search",
    dims: () => {
      const queries = ["analytics", "pricing", "docs", "api", "events", "dashboard", "setup"];
      return {
        "search.query": queries[Math.floor(Math.random() * queries.length)],
        "search.results_count": Math.floor(Math.random() * 50),
      };
    },
  },
  {
    event: "error",
    dims: () => {
      const errors = ["TypeError: Cannot read property", "NetworkError: Failed to fetch", "SyntaxError: Unexpected token", "RangeError: Maximum call stack"];
      return {
        "error.message": errors[Math.floor(Math.random() * errors.length)],
        "error.fatal": Math.random() > 0.7,
      };
    },
  },
  {
    event: "session_start",
    dims: () => ({
      "device.type": ["desktop", "mobile", "tablet"][Math.floor(Math.random() * 3)],
      "browser.name": ["Chrome", "Firefox", "Safari", "Edge"][Math.floor(Math.random() * 4)],
    }),
  },
  {
    event: "session_end",
    dims: () => ({
      "session.duration_s": Math.floor(Math.random() * 600) + 10,
      "session.pages_viewed": Math.floor(Math.random() * 12) + 1,
    }),
  },
  {
    event: "purchase",
    dims: () => ({
      "product.name": ["Pro Plan", "Team Plan", "Enterprise"][Math.floor(Math.random() * 3)],
      "product.price": [9.99, 29.99, 99.99][Math.floor(Math.random() * 3)],
      "payment.method": ["card", "paypal", "bank"][Math.floor(Math.random() * 3)],
    }),
  },
];

// ── Synthetic enriched dimensions (simulates server-side enrichment for local dev) ──

const FAKE_COUNTRIES = ["US", "GB", "DE", "FR", "JP", "AU", "CA", "BR", "IN", "NL"];
const FAKE_BROWSERS = ["Chrome", "Firefox", "Safari", "Edge"];
const FAKE_BROWSER_VERSIONS: Record<string, string[]> = {
  Chrome: ["130", "129", "128"], Firefox: ["133", "132"], Safari: ["18", "17"], Edge: ["130", "129"],
};
const FAKE_OS = ["Windows", "macOS", "Linux", "iOS", "Android"];
const FAKE_DEVICE_TYPES = ["desktop", "desktop", "desktop", "mobile", "mobile", "tablet"]; // weighted

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function syntheticEnrichedDims(): Record<string, string> {
  const browser = pick(FAKE_BROWSERS);
  return {
    "geo.country": pick(FAKE_COUNTRIES),
    "client.browser": browser,
    "client.browser_version": pick(FAKE_BROWSER_VERSIONS[browser]),
    "client.os": pick(FAKE_OS),
    "client.device_type": pick(FAKE_DEVICE_TYPES),
  };
}

// ── Generate events ─────────────────────────────────────────────────

const count = countArg ? parseInt(countArg, 10) : Math.floor(Math.random() * 9) + 2; // 2-10
const sessionId = sessionArg ?? `sess_${Math.random().toString(36).slice(2, 10)}`;

const events: Array<{
  event: string;
  timestamp: string;
  session_id: string;
  dimensions: Record<string, string | number | boolean>;
}> = [];

for (let i = 0; i < count; i++) {
  const pool = eventArg
    ? EVENT_POOL.find((e) => e.event === eventArg) ?? { event: eventArg, dims: () => ({}) }
    : EVENT_POOL[Math.floor(Math.random() * EVENT_POOL.length)];

  // Spread timestamps over the last 5 minutes
  const offsetMs = Math.floor(Math.random() * 5 * 60 * 1000);
  const ts = new Date(Date.now() - offsetMs).toISOString();

  events.push({
    event: pool.event,
    timestamp: ts,
    session_id: sessionId,
    dimensions: {
      ...syntheticEnrichedDims(),
      ...pool.dims(), // user dims override enriched (same precedence as server)
    },
  });
}

// ── Send ─────────────────────────────────────────────────────────────

const url = `http://localhost:${port}/v1/events`;
console.log(`Sending ${events.length} events to ${url}`);
console.log(`Session: ${sessionId}`);
console.log(`Events: ${events.map((e) => e.event).join(", ")}`);
console.log("");

try {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ events }),
  });

  const body = await res.json();
  console.log(`Status: ${res.status}`);
  console.log(JSON.stringify(body, null, 2));
} catch (err) {
  console.error("Failed to send events:", err);
  process.exit(1);
}
