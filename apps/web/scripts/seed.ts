#!/usr/bin/env bun
/**
 * Seed script — creates the first app and admin API key.
 *
 * Usage:
 *   bun run scripts/seed.ts
 *
 * Reads TURSO_DATABASE_URL and TURSO_AUTH_TOKEN from .dev.vars or env.
 *
 * For local dev with `turso dev --db-file local.db`:
 *   TURSO_DATABASE_URL=http://127.0.0.1:8080
 *   TURSO_AUTH_TOKEN=unused        (or omit — not needed locally)
 */

import { createClient as createWebClient } from "@libsql/client/web";
import { createClient as createNodeClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { ulid } from "../src/api/lib/ulid";
import { generateApiKey } from "../src/api/lib/crypto";

// Read .dev.vars if present (KEY=VALUE, one per line)
const devVarsPath = new URL("../.dev.vars", import.meta.url).pathname;
try {
  const content = await Bun.file(devVarsPath).text();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  // .dev.vars doesn't exist — that's fine, rely on env
}

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  console.error("Error: TURSO_DATABASE_URL must be set.");
  console.error("");
  console.error("For local dev, create apps/web/.dev.vars with:");
  console.error("  TURSO_DATABASE_URL=file:local.db");
  console.error("");
  console.error("Or for remote Turso:");
  console.error("  TURSO_DATABASE_URL=libsql://your-db.turso.io");
  console.error("  TURSO_AUTH_TOKEN=your-token");
  process.exit(1);
}

const isLocal = url.startsWith("file:");
const client = isLocal
  ? createNodeClient({ url })
  : createWebClient({ url, authToken: authToken! });
const db = drizzle(client, { schema });

const appName = process.argv[2] || "Default App";
const now = new Date().toISOString();

// Idempotency: skip if an app with this name already exists
const existing = await db
  .select({ id: schema.apps.id })
  .from(schema.apps)
  .where(eq(schema.apps.name, appName))
  .limit(1);

if (existing.length > 0) {
  // Fetch the existing key to display it
  const existingKeys = await db
    .select({ rawKey: schema.appKeys.rawKey })
    .from(schema.appKeys)
    .where(eq(schema.appKeys.appId, existing[0].id))
    .limit(1);

  console.log("");
  console.log(`Already seeded: app "${appName}" exists (${existing[0].id})`);
  if (existingKeys.length > 0 && existingKeys[0].rawKey) {
    console.log("");
    console.log("Ingest API Key:");
    console.log(`  ${existingKeys[0].rawKey}`);
  }
  console.log("");
  process.exit(0);
}

// Create the app
const appId = ulid();
await db.insert(schema.apps).values({
  id: appId,
  name: appName,
  geoPrecision: "country",
  retentionDays: 90,
  createdAt: now,
});

// Create an ingest API key
const { rawKey: ingestKey, keyHash: ingestHash, keyPrefix: ingestPrefix } =
  await generateApiKey("live");

await db.insert(schema.appKeys).values({
  id: ulid(),
  appId,
  keyHash: ingestHash,
  keyPrefix: ingestPrefix,
  rawKey: ingestKey,
  name: "Default ingest key",
  createdAt: now,
});

console.log("");
console.log("=== statsfactory seed complete ===");
console.log("");
console.log(`App:      ${appName}`);
console.log(`App ID:   ${appId}`);
console.log("");
console.log("Ingest API Key (for sending events):");
console.log(`  ${ingestKey}`);
console.log("");
console.log("Dashboard access is managed by Cloudflare Access.");
console.log("");
