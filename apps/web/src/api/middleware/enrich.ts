import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { apps } from "../../db/schema";
import { parseUserAgent } from "../lib/ua-parser";
import type { Database } from "../../db/client";
import type { AppEnv } from "../index";

type GeoPrecision = "country" | "city" | "none";

/**
 * Complete list of all enriched dimension keys the system can produce.
 * Exported so the UI can show toggles for every dimension.
 */
export const ALL_ENRICHED_DIMS: readonly string[] = [
  // Geo (country precision)
  "geo.country",
  "geo.continent",
  "geo.timezone",
  // Geo (city precision — only extracted when geo_precision = "city")
  "geo.region",
  "geo.city",
  "geo.latitude",
  "geo.longitude",
  // Network
  "net.asn",
  "net.as_org",
  "net.colo",
  "net.tls_version",
  "net.http_protocol",
  // Client — browser UA
  "client.browser",
  "client.browser_version",
  "client.os",
  "client.device_type",
  // Client — SDK UA
  "sdk.name",
  "sdk.version",
  "client.name",
  "client.version",
  "client.arch",
];

/**
 * Default enabled enriched dimensions for new apps.
 * Tuned for D1 free tier cost efficiency — each enabled dim adds 1 row
 * written per event. Only the highest-value dims are on by default.
 *
 * New apps inherit this list via the `enabled_dims` column.
 * Per-app overrides are stored in the apps table as a JSON array.
 */
export const DEFAULT_ENABLED_DIMS: readonly string[] = [
  // Geo — country is high-value and cheap
  "geo.country",
  // Client — browser and SDK dims are high-value for usage analytics
  "client.browser",
  "client.browser_version",
  "client.os",
  "client.device_type",
  "sdk.name",
  "sdk.version",
  "client.name",
  "client.version",
  "client.arch",
];

// ── TTL cache for app config ────────────────────────────────────────────────
// Avoids a D1 read on every ingest request. Default TTL: 1 hour.

const APP_CONFIG_TTL_MS = 60 * 60 * 1000; // 1 hour

type AppConfig = {
  geoPrecision: GeoPrecision;
  enabledDims: ReadonlySet<string>;
  expiresAt: number;
};

const appConfigCache = new Map<string, AppConfig>();

/**
 * Get app config from cache or DB. The query piggybacks on the existing
 * geo_precision lookup — no extra D1 round-trip.
 */
async function getAppConfig(
  db: Database,
  appId: string,
): Promise<AppConfig> {
  const cached = appConfigCache.get(appId);
  if (cached && Date.now() < cached.expiresAt) return cached;

  const [app] = await db
    .select({ geoPrecision: apps.geoPrecision, enabledDims: apps.enabledDims })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1);

  let enabledSet: ReadonlySet<string>;
  if (app?.enabledDims) {
    try {
      const parsed = JSON.parse(app.enabledDims);
      enabledSet = new Set(Array.isArray(parsed) ? parsed : DEFAULT_ENABLED_DIMS);
    } catch {
      enabledSet = new Set(DEFAULT_ENABLED_DIMS);
    }
  } else {
    enabledSet = new Set(DEFAULT_ENABLED_DIMS);
  }

  const config: AppConfig = {
    geoPrecision: (app?.geoPrecision as GeoPrecision) ?? "country",
    enabledDims: enabledSet,
    expiresAt: Date.now() + APP_CONFIG_TTL_MS,
  };

  appConfigCache.set(appId, config);
  return config;
}

/** Invalidate cache for an app (call after PATCH /apps/:appId). */
export function invalidateAppConfig(appId: string): void {
  appConfigCache.delete(appId);
}

/**
 * Keep only enabled dimensions from an enriched dimensions record.
 */
function filterEnabled(dims: Record<string, string>, enabled: ReadonlySet<string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(dims)) {
    if (enabled.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/** Subset of Cloudflare's IncomingRequestCfProperties we use for enrichment. */
interface CfProperties {
  country?: string;
  continent?: string;
  timezone?: string;
  region?: string;
  city?: string;
  latitude?: string;
  longitude?: string;
  asn?: number;
  asOrganization?: string;
  colo?: string;
  tlsVersion?: string;
  httpProtocol?: string;
}

/**
 * Extract geo dimensions from the CF request object based on app's geo precision.
 */
export function extractGeoDimensions(
  cf: CfProperties | undefined,
  precision: GeoPrecision,
): Record<string, string> {
  if (!cf || precision === "none") return {};

  const dims: Record<string, string> = {};

  // Country-level (always included if precision != "none")
  if (cf.country) dims["geo.country"] = String(cf.country);
  if (cf.continent) dims["geo.continent"] = String(cf.continent);
  if (cf.timezone) dims["geo.timezone"] = String(cf.timezone);

  // City-level (only if precision is "city")
  if (precision === "city") {
    if (cf.region) dims["geo.region"] = String(cf.region);
    if (cf.city) dims["geo.city"] = String(cf.city);
    if (cf.latitude) dims["geo.latitude"] = String(cf.latitude);
    if (cf.longitude) dims["geo.longitude"] = String(cf.longitude);
  }

  return dims;
}

/**
 * Extract network dimensions from the CF request object.
 */
export function extractNetDimensions(
  cf: CfProperties | undefined,
): Record<string, string> {
  if (!cf) return {};

  const dims: Record<string, string> = {};
  if (cf.asn) dims["net.asn"] = String(cf.asn);
  if (cf.asOrganization) dims["net.as_org"] = String(cf.asOrganization);
  if (cf.colo) dims["net.colo"] = String(cf.colo);
  if (cf.tlsVersion) dims["net.tls_version"] = String(cf.tlsVersion);
  if (cf.httpProtocol) dims["net.http_protocol"] = String(cf.httpProtocol);

  return dims;
}

/**
 * Enrichment middleware — runs after auth.
 *
 * Extracts geo, network, and User-Agent dimensions from the request
 * and attaches them to the context for the ingest route to merge
 * into each event. Uses a TTL cache to avoid querying D1 on every request.
 */
export const enrichMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const appId = c.get("appId");
  const db = c.get("db");

  // Look up app config (cached, includes geo precision + enabled dims)
  const config = await getAppConfig(db, appId);

  // Get CF request metadata (only available in production, not in dev)
  const cf = (c.req.raw as Request & { cf?: CfProperties }).cf;

  const geoDims = extractGeoDimensions(cf, config.geoPrecision);
  const netDims = extractNetDimensions(cf);
  const uaDims = parseUserAgent(c.req.header("User-Agent") ?? null);

  const allEnriched = { ...geoDims, ...netDims, ...uaDims };
  c.set("enrichedDimensions", filterEnabled(allEnriched, config.enabledDims));

  await next();
});
