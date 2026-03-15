#!/usr/bin/env bun
/**
 * Seed script — creates the first app and admin API key.
 *
 * Usage:
 *   STATSFACTORY_DB_PATH=/path/to/d1.sqlite bun run scripts/seed.ts [app-name]
 *
 * The justfile `setup-seed` recipe finds the miniflare D1 SQLite file
 * and passes it via STATSFACTORY_DB_PATH automatically.
 */

import { Database } from "bun:sqlite";
import { ulid } from "../src/api/lib/ulid";
import { generateApiKey } from "../src/api/lib/crypto";

const dbPath = process.env.STATSFACTORY_DB_PATH;

if (!dbPath) {
  console.error("Error: STATSFACTORY_DB_PATH must be set.");
  console.error("");
  console.error("For local dev, run: just setup-seed");
  console.error("(It finds the miniflare D1 SQLite file automatically.)");
  process.exit(1);
}

const db = new Database(dbPath);
db.exec("PRAGMA foreign_keys = ON");

const appName = process.argv[2] || "Default App";
const now = new Date().toISOString();

// Idempotency: skip if an app with this name already exists
const existing = db.prepare("SELECT id FROM apps WHERE name = ? LIMIT 1").get(appName) as { id: string } | null;

if (existing) {
  // Fetch the existing key to display it
  const existingKey = db.prepare("SELECT raw_key FROM app_keys WHERE app_id = ? LIMIT 1").get(existing.id) as { raw_key: string } | null;

  console.log("");
  console.log(`Already seeded: app "${appName}" exists (${existing.id})`);
  if (existingKey?.raw_key) {
    console.log("");
    console.log("Ingest API Key:");
    console.log(`  ${existingKey.raw_key}`);
  }
  console.log("");
  process.exit(0);
}

// Create the app
const appId = ulid();
db.prepare(
  "INSERT INTO apps (id, name, geo_precision, retention_days, created_at) VALUES (?, ?, ?, ?, ?)"
).run(appId, appName, "country", 90, now);

// Create an ingest API key
const { rawKey: ingestKey, keyHash: ingestHash, keyPrefix: ingestPrefix } =
  await generateApiKey("live");

db.prepare(
  "INSERT INTO app_keys (id, app_id, key_hash, key_prefix, raw_key, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
).run(ulid(), appId, ingestHash, ingestPrefix, ingestKey, "Default ingest key", now);

db.close();

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
