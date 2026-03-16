import { createMiddleware } from "hono/factory";
import { eq, and, isNull } from "drizzle-orm";
import { appKeys } from "../../db/schema";
import { hashKey } from "../lib/crypto";
import type { AppEnv } from "../index";

/**
 * App key authentication middleware (ingest only).
 *
 * Expects: `Authorization: Bearer <app-key>`
 * Sets `c.set("appId", ...)` on success.
 *
 * App keys are public keys embedded in client applications. They identify
 * which app/project events belong to. Multiple keys can map to the same app.
 */
export const appKeyAuth = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const rawKey = authHeader.slice(7);
  if (!rawKey) {
    return c.json({ error: "Empty app key" }, 401);
  }

  const hash = await hashKey(rawKey);
  const db = c.get("db");

  const [keyRow] = await db
    .select()
    .from(appKeys)
    .where(and(eq(appKeys.keyHash, hash), isNull(appKeys.revokedAt)))
    .limit(1);

  if (!keyRow) {
    return c.json({ error: "Invalid or revoked app key" }, 401);
  }

  c.set("appId", keyRow.appId);

  await next();
});

/**
 * Cloudflare Access authentication middleware (dashboard + admin).
 *
 * In production, Cloudflare Access sits in front of the Worker and adds
 * a signed JWT (`Cf-Access-JWT-Assertion` header) with the user's identity.
 * The CF Access policy controls WHO can access the dashboard/admin routes.
 *
 * In development (no CF_ACCESS_TEAM_DOMAIN configured), the middleware checks
 * for STATSFACTORY_DEV=1 to enable dev bypass with a default dev email.
 * This ensures fail-closed in production if CF_ACCESS_TEAM_DOMAIN is missing.
 *
 * Sets `c.set("cfAccessEmail", ...)` on success.
 */
export const cfAccessAuth = createMiddleware<AppEnv>(async (c, next) => {
  const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN;

  if (!teamDomain) {
    // Only allow dev bypass when explicitly opted in via STATSFACTORY_DEV.
    // In production (Cloudflare Workers), fail closed — reject all requests
    // if CF_ACCESS_TEAM_DOMAIN is not configured.
    // Env vars are always strings, so treat "0", "false", "no", "" as disabled.
    const devFlag = c.env.STATSFACTORY_DEV?.toLowerCase();
    if (!devFlag || devFlag === "0" || devFlag === "false" || devFlag === "no") {
      return c.json({ error: "Forbidden" }, 403);
    }

    // Local dev: allow all requests with a synthetic identity
    c.set("cfAccessEmail", "dev@localhost");
    await next();
    return;
  }

  // In production, CF Access adds these headers:
  // - Cf-Access-JWT-Assertion: signed JWT
  // - Cf-Access-Authenticated-User-Email: user's email (convenience header)
  //
  // For full security, you should validate the JWT against CF Access certs.
  // For now, we trust the convenience header since CF Access is the outer
  // proxy and strips/overwrites these headers from client requests.
  const email = c.req.header("Cf-Access-Authenticated-User-Email");

  if (!email) {
    const requestUrl = new URL(c.req.url);
    const loginUrl = `${requestUrl.origin}/cdn-cgi/access/login`;
    return c.json(
      {
        error: "Cloudflare Access authentication required",
        login_url: loginUrl,
      },
      401,
    );
  }

  c.set("cfAccessEmail", email);

  await next();
});
