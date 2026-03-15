import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../index";

/**
 * In-memory sliding window rate limiter for event ingestion.
 *
 * Limits requests per app key (identified by appId after auth).
 * Uses a sliding window counter that resets per CF Worker isolate.
 *
 * **Trade-offs:**
 * - Per-isolate: each Worker isolate has its own counter, so the effective
 *   limit is `MAX_REQUESTS * number_of_isolates`. This is acceptable for
 *   abuse protection (not precise metering).
 * - Resets on cold start: counters are lost when the isolate is recycled.
 *   This is fine — rate limiting is defense-in-depth, not billing.
 *
 * For stricter limits, use Cloudflare Rate Limiting rules (infrastructure-level)
 * or Durable Objects for global state.
 */

// ── Configuration ───────────────────────────────────────────────────────────

/** Max requests per window per app. */
const MAX_REQUESTS_PER_WINDOW = 100;

/** Window duration in milliseconds (60 seconds). */
const WINDOW_MS = 60_000;

/** How often to prune expired entries (every 100 requests). */
const PRUNE_INTERVAL = 100;

// ── State ───────────────────────────────────────────────────────────────────

/**
 * Sliding window state: map of appId -> array of request timestamps.
 * Kept in module-level scope so it persists across requests within
 * the same isolate lifetime.
 */
const windows = new Map<string, number[]>();
let requestCounter = 0;

/**
 * Remove expired timestamps from all windows.
 * Called periodically to prevent memory growth.
 */
function pruneExpired(): void {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, timestamps] of windows) {
    const valid = timestamps.filter((t) => t > cutoff);
    if (valid.length === 0) {
      windows.delete(key);
    } else {
      windows.set(key, valid);
    }
  }
}

// ── Middleware ───────────────────────────────────────────────────────────────

/**
 * Rate limiting middleware for ingest routes.
 *
 * Must be applied AFTER `appKeyAuth` (needs `appId` in context).
 * Returns 429 Too Many Requests when the limit is exceeded.
 *
 * Response headers:
 * - `X-RateLimit-Limit`: max requests per window
 * - `X-RateLimit-Remaining`: requests remaining in current window
 * - `X-RateLimit-Reset`: seconds until the oldest request in window expires
 */
export const rateLimitMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const appId = c.get("appId");
  if (!appId) {
    // If appKeyAuth hasn't set appId, skip rate limiting
    // (the request will fail auth anyway)
    await next();
    return;
  }

  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  // Periodic pruning
  requestCounter++;
  if (requestCounter % PRUNE_INTERVAL === 0) {
    pruneExpired();
  }

  // Get or create window for this app
  let timestamps = windows.get(appId);
  if (!timestamps) {
    timestamps = [];
    windows.set(appId, timestamps);
  }

  // Filter to current window only
  const validTimestamps = timestamps.filter((t) => t > cutoff);
  windows.set(appId, validTimestamps);

  const remaining = Math.max(0, MAX_REQUESTS_PER_WINDOW - validTimestamps.length);

  // Set rate limit headers on all responses
  c.header("X-RateLimit-Limit", String(MAX_REQUESTS_PER_WINDOW));
  c.header("X-RateLimit-Remaining", String(remaining));

  if (validTimestamps.length > 0) {
    const oldestInWindow = Math.min(...validTimestamps);
    const resetSeconds = Math.ceil((oldestInWindow + WINDOW_MS - now) / 1000);
    c.header("X-RateLimit-Reset", String(Math.max(0, resetSeconds)));
  } else {
    c.header("X-RateLimit-Reset", String(Math.ceil(WINDOW_MS / 1000)));
  }

  if (validTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    return c.json(
      {
        error: `Rate limit exceeded. Max ${MAX_REQUESTS_PER_WINDOW} requests per ${WINDOW_MS / 1000}s per app.`,
      },
      429,
    );
  }

  // Record this request
  validTimestamps.push(now);

  await next();
});
