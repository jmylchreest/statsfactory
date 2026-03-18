#!/usr/bin/env bun
/**
 * statsfactory deploy script
 *
 * Pure Cloudflare TypeScript SDK — no wrangler dependency at deploy time.
 * Builds the Astro project (if needed), uploads assets + worker modules,
 * and configures D1 bindings, cron triggers, and Cloudflare Access.
 *
 * Usage:
 *   bun run scripts/deploy.ts install [--name <instance>]
 *   bun run scripts/deploy.ts upgrade [--name <instance>]
 *   bun run scripts/deploy.ts reconfigure-access [--name <instance>]
 *   bun run scripts/deploy.ts destroy [--name <instance>]
 *
 * The --name flag (or STATSFACTORY_NAME env var) allows multiple independent
 * instances. Default is "statsfactory". With --name prod the worker becomes
 * "statsfactory-prod", the D1 database "statsfactory-prod", etc.
 *
 * Environment variables (optional — prompts if not set):
 *   CLOUDFLARE_API_TOKEN      API token (see README for required permissions)
 *   CF_ACCESS_TEAM_DOMAIN     Cloudflare Access team domain
 *   STATSFACTORY_DOMAIN       Custom domain (e.g. stats.example.com)
 *   STATSFACTORY_NAME         Instance name (same as --name flag)
 *   STATSFACTORY_D1_ID        D1 database ID (for CI — skips deploy config file)
 */

import Cloudflare, { toFile } from "cloudflare";
import type { AccessRule } from "cloudflare/resources/zero-trust/access/applications";
import { AuthenticationError, PermissionDeniedError, APIError } from "cloudflare/error";
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, mkdirSync } from "fs";
import { resolve, join, extname, relative } from "path";
import { createInterface } from "readline";
import { createHash } from "crypto";

// ── Constants ──────────────────────────────────────────────────────────────

const WEB_DIR = "apps/web";
const DIST_DIR = join(WEB_DIR, "dist");
const CLIENT_DIR = join(DIST_DIR, "client");
const SERVER_DIR = join(DIST_DIR, "server");
const ENTRY_MODULE = join(SERVER_DIR, "entry.mjs");
const COMPAT_DATE = "2026-03-12";
const COMPAT_FLAGS = ["nodejs_compat"];
const CRON_SCHEDULE = "0 3 * * *"; // Data retention — daily at 03:00 UTC
const GITHUB_REPO = "jmylchreest/statsfactory"; // For --download flag

// ── Instance naming ───────────────────────────────────────────────────────
//
// --name <instance> or STATSFACTORY_NAME env var.  Default is bare
// "statsfactory".  With --name prod → worker "statsfactory-prod",
// D1 "statsfactory-prod", Access apps "statsfactory-prod-*", and
// deploy config "wrangler-deploy-prod.toml".

function parseInstanceName(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--name");
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return process.env.STATSFACTORY_NAME || "";
}

const INSTANCE_SUFFIX = parseInstanceName();
const WORKER_NAME = INSTANCE_SUFFIX ? `statsfactory-${INSTANCE_SUFFIX}` : "statsfactory";
const DB_NAME = WORKER_NAME; // worker and DB share the same name
const DEPLOY_TOML = INSTANCE_SUFFIX
  ? join(WEB_DIR, `wrangler-deploy-${INSTANCE_SUFFIX}.toml`)
  : join(WEB_DIR, "wrangler-deploy.toml");

// ── Helpers ────────────────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function info(msg: string): void {
  console.log(`==> ${msg}`);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${prompt}: `, (answer) => resolve(answer.trim()));
  });
}

/** Run a shell command, streaming output. Returns exit code. */
async function run(cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<number> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd,
    env: opts?.env ? { ...process.env, ...opts.env } : undefined,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  return proc.exited;
}

/** Get or prompt for an environment variable. */
async function getEnvOrAsk(envKey: string, prompt: string, help?: string): Promise<string> {
  const val = process.env[envKey];
  if (val) return val;
  if (help) console.log(`\n${help}`);
  const answer = await ask(prompt);
  if (!answer) die(`${envKey} is required.`);
  return answer;
}

// ── Cloudflare SDK client ──────────────────────────────────────────────────

let _client: Cloudflare | null = null;

async function getClient(): Promise<Cloudflare> {
  if (_client) return _client;

  const token = await getEnvOrAsk(
    "CLOUDFLARE_API_TOKEN",
    "Cloudflare API Token",
    [
      "A Cloudflare API token is required for managing D1, secrets, and Access.",
      "Wrangler's login token does not include Zero Trust permissions.",
      "",
      "Create one at: https://dash.cloudflare.com/profile/api-tokens",
      "  -> Create Custom Token",
      "",
      "  Token name:     statsfactory",
      "  Permissions:    Account | D1 | Edit",
      "                  Account | Worker Scripts | Edit",
      "                  Account | Access: Organizations, Identity Providers, and Groups | Read",
      "                  Zone | Workers Routes | Edit",
      "                  Zone | DNS | Edit",
      "                  Zone | Access: Apps and Policies | Edit",
      "  Zone Resources: Include | Specific zone | <your domain>",
      "",
      "You can set CLOUDFLARE_API_TOKEN in your environment to skip this prompt.",
    ].join("\n"),
  );

  _client = new Cloudflare({ apiToken: token });

  // Validate the token works before proceeding
  try {
    const verify = await _client.user.tokens.verify();
    if (verify.status !== "active") {
      die(`API token is ${verify.status}. Please create a new active token.`);
    }
  } catch (e) {
    if (e instanceof AuthenticationError) {
      die("API token is invalid. Check the token and try again.");
    }
    throw e;
  }

  return _client;
}

/** Get the Cloudflare account ID. */
async function getAccountId(): Promise<string> {
  const client = await getClient();
  try {
    for await (const account of client.accounts.list()) {
      if (account.id) return account.id;
    }
  } catch (e) {
    if (e instanceof PermissionDeniedError || e instanceof AuthenticationError) {
      die(
        "API token does not have permission to list accounts.\n" +
          "Required permissions:\n" +
          "  Account | D1 | Edit\n" +
          "  Account | Worker Scripts | Edit\n" +
          "  Account | Access: Organizations, Identity Providers, and Groups | Read\n" +
          "  Zone | Workers Routes | Edit\n" +
          "  Zone | DNS | Edit\n" +
          "  Zone | Access: Apps and Policies | Edit\n\n" +
          "Create a token at: https://dash.cloudflare.com/profile/api-tokens",
      );
    }
    throw e;
  }
  die("No Cloudflare account found for this API token.");
}

/**
 * Format a Cloudflare API error with actionable context.
 * Tells the user which permission is likely missing.
 */
function formatApiError(e: unknown, context: string): never {
  if (e instanceof PermissionDeniedError) {
    const permHints: Record<string, string> = {
      d1: "Account | D1 | Edit",
      zone: "Zone | DNS | Edit (or broader zone access)",
      route: "Zone | Workers Routes | Edit",
      dns: "Zone | DNS | Edit",
      access: "Zone | Access: Apps and Policies | Edit",
      secret: "Account | Worker Scripts | Edit",
      worker: "Account | Worker Scripts | Edit",
    };
    const hint = Object.entries(permHints).find(([key]) =>
      context.toLowerCase().includes(key),
    );
    die(
      `Permission denied: ${context}\n` +
        `Your API token is missing a required permission.\n` +
        (hint ? `Likely missing: ${hint[1]}\n` : "") +
        `\nCheck your token at: https://dash.cloudflare.com/profile/api-tokens`,
    );
  }
  if (e instanceof AuthenticationError) {
    die("API token is invalid or expired. Check the token and try again.");
  }
  if (e instanceof APIError) {
    die(`Cloudflare API error (${context}): ${e.message}`);
  }
  throw e;
}

/**
 * Find the Cloudflare zone ID for a given domain.
 * Walks up the domain hierarchy: stats.example.com -> example.com
 */
async function getZoneId(domain: string): Promise<string> {
  const client = await getClient();
  let candidate = domain;
  try {
    while (candidate.includes(".")) {
      for await (const zone of client.zones.list({ name: candidate })) {
        if (zone.id && zone.status === "active") return zone.id;
      }
      // Strip leftmost label: stats.example.com -> example.com
      candidate = candidate.substring(candidate.indexOf(".") + 1);
    }
  } catch (e) {
    formatApiError(e, "zone lookup");
  }
  die(
    `No active Cloudflare zone found for '${domain}'.\n` +
      `Make sure the domain is added to your Cloudflare account and using Cloudflare nameservers.`,
  );
}

// ── D1 operations ──────────────────────────────────────────────────────────

/** Find or create the D1 database. Returns the database ID. */
async function ensureD1(accountId: string): Promise<string> {
  const client = await getClient();

  try {
    // Check if database already exists
    for await (const db of client.d1.database.list({ account_id: accountId })) {
      if (db.name === DB_NAME) {
        info(`D1 database '${DB_NAME}' already exists (${db.uuid}).`);
        return db.uuid!;
      }
    }

    // Create it
    info(`Creating D1 database '${DB_NAME}'...`);
    const db = await client.d1.database.create({
      account_id: accountId,
      name: DB_NAME,
    });
    if (!db.uuid) die("Failed to create D1 database — no UUID returned.");
    info(`D1 database created: ${db.uuid}`);
    return db.uuid;
  } catch (e) {
    formatApiError(e, "D1 database create/list");
  }
}

/** Apply migrations via the D1 API (replicating wrangler d1 migrations apply). */
async function applyMigrations(accountId: string, dbId: string): Promise<void> {
  const client = await getClient();
  const migrationsDir = resolve(WEB_DIR, "migrations");

  if (!existsSync(migrationsDir)) {
    info("No migrations directory found, skipping.");
    return;
  }

  // Ensure the d1_migrations tracking table exists
  await client.d1.database.query(dbId, {
    account_id: accountId,
    sql: `CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  });

  // Get already-applied migrations
  const applied = new Set<string>();
  const rows = client.d1.database.query(dbId, {
    account_id: accountId,
    sql: "SELECT name FROM d1_migrations ORDER BY id",
  });
  for await (const result of rows) {
    if (result.results) {
      for (const row of result.results as Array<{ name: string }>) {
        applied.add(row.name);
      }
    }
  }

  // Read migration files sorted by name
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    info("All migrations already applied.");
    return;
  }

  for (const file of pending) {
    info(`Applying migration: ${file}...`);
    const sql = readFileSync(join(migrationsDir, file), "utf-8");

    // Execute the migration SQL
    await client.d1.database.query(dbId, {
      account_id: accountId,
      sql,
    });

    // Record it
    await client.d1.database.query(dbId, {
      account_id: accountId,
      sql: "INSERT INTO d1_migrations (name) VALUES (?)",
      params: [file],
    });

    info(`  Applied: ${file}`);
  }
}

// ── Secrets ────────────────────────────────────────────────────────────────

/** Set a Worker secret (idempotent — overwrites if exists). */
async function ensureSecret(accountId: string, name: string, value: string): Promise<void> {
  const client = await getClient();
  await client.workers.scripts.secrets.update(WORKER_NAME, {
    account_id: accountId,
    name,
    text: value,
    type: "secret_text",
  });
  info(`Secret '${name}' set.`);
}

// ── Deploy config (wrangler-deploy[-name].toml) ────────────────────────────
//
// Deploy-specific values (database_id, custom domain) live in a gitignored
// file (DEPLOY_TOML, set above based on --name).

interface DeployConfig {
  database_id: string;
  domain?: string;
}

function readDeployConfig(): DeployConfig | null {
  // Try the deploy config file first
  if (existsSync(DEPLOY_TOML)) {
    const raw = readFileSync(DEPLOY_TOML, "utf-8");
    const dbMatch = raw.match(/database_id = "([^"]+)"/);
    const domainMatch = raw.match(/domain = "([^"]+)"/);
    if (dbMatch) {
      return {
        database_id: dbMatch[1],
        domain: domainMatch?.[1],
      };
    }
  }

  // Fall back to environment variables (useful for CI)
  const dbId = process.env.STATSFACTORY_D1_ID;
  const domain = process.env.STATSFACTORY_DOMAIN;
  if (dbId) {
    return { database_id: dbId, domain };
  }

  return null;
}

function writeDeployConfig(config: DeployConfig): void {
  const lines = [
    "# Generated by deploy.ts — do not edit manually.",
    "# This file is gitignored. It stores deploy-specific values.",
    "",
    `database_id = "${config.database_id}"`,
  ];
  if (config.domain) {
    lines.push(`domain = "${config.domain}"`);
  }
  lines.push("");
  writeFileSync(DEPLOY_TOML, lines.join("\n"));
  info(`Deploy config written to ${DEPLOY_TOML}.`);
}

function removeDeployConfig(): void {
  if (existsSync(DEPLOY_TOML)) {
    unlinkSync(DEPLOY_TOML);
  }
}

// ── Release download ──────────────────────────────────────────────────────

/**
 * Parse the --download flag value from CLI args.
 * Returns null if not set, "latest" for latest stable, or a specific tag.
 */
function parseDownloadFlag(): string | null {
  for (const arg of process.argv.slice(2)) {
    if (arg === "--download") return "latest";
    if (arg.startsWith("--download=")) return arg.slice("--download=".length);
  }
  return null;
}

/**
 * Download a release bundle from GitHub Releases and extract it.
 *
 * For "latest": fetches the latest non-prerelease GitHub Release.
 * For "snapshot": fetches the rolling snapshot pre-release.
 * For a specific tag (e.g. "v0.1.0"): fetches that exact release.
 *
 * Downloads the .tar.gz asset and extracts it over the current directory,
 * giving the user a pre-built dist/ plus deploy scripts.
 */
async function downloadRelease(version: string): Promise<void> {
  const apiBase = `https://api.github.com/repos/${GITHUB_REPO}`;

  let releaseUrl: string;
  if (version === "latest") {
    releaseUrl = `${apiBase}/releases/latest`;
  } else {
    // Could be "snapshot" or "v0.1.0" etc
    const tag = version.startsWith("v") || version === "snapshot" ? version : `v${version}`;
    releaseUrl = `${apiBase}/releases/tags/${tag}`;
  }

  info(`Fetching release info (${version})...`);
  const releaseRes = await fetch(releaseUrl, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!releaseRes.ok) {
    if (releaseRes.status === 404) {
      die(
        `Release '${version}' not found.\n` +
          `Check available releases at: https://github.com/${GITHUB_REPO}/releases`,
      );
    }
    die(`GitHub API error: ${releaseRes.status} ${await releaseRes.text()}`);
  }

  const release = (await releaseRes.json()) as {
    tag_name: string;
    name: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  };

  // Find the .tar.gz asset
  const tarAsset = release.assets.find((a) => a.name.endsWith(".tar.gz"));
  if (!tarAsset) {
    die(
      `Release '${release.tag_name}' has no .tar.gz asset.\n` +
        `Available assets: ${release.assets.map((a) => a.name).join(", ") || "(none)"}`,
    );
  }

  info(`Downloading ${tarAsset.name}...`);
  const dlRes = await fetch(tarAsset.browser_download_url, {
    redirect: "follow",
  });
  if (!dlRes.ok) {
    die(`Download failed: ${dlRes.status} ${dlRes.statusText}`);
  }

  // Extract tarball over current directory
  info("Extracting release bundle...");
  const tarData = new Uint8Array(await dlRes.arrayBuffer());

  // Write to a temp file and extract with tar (bun doesn't have native tar)
  const tmpFile = `.statsfactory-release-${Date.now()}.tar.gz`;
  writeFileSync(tmpFile, tarData);
  try {
    const extractCode = await run(["tar", "xzf", tmpFile]);
    if (extractCode !== 0) die("Failed to extract release bundle.");
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore cleanup failure
    }
  }

  info(`Release ${release.tag_name} (${release.name || release.tag_name}) extracted.`);
}

// ── Build ──────────────────────────────────────────────────────────────────

/**
 * Build the Astro project if dist/ does not exist or --build is passed.
 * When running from a pre-built release artifact, dist/ already exists
 * and this step is skipped.
 */
async function ensureBuild(): Promise<void> {
  const forceRebuild = process.argv.includes("--build");

  if (!forceRebuild && existsSync(ENTRY_MODULE)) {
    info("Build output found (dist/server/entry.mjs), skipping build.");
    info("Pass --build to force a rebuild.");
    return;
  }

  info("Building Astro project...");
  const buildCode = await run(["bunx", "astro", "build"], { cwd: WEB_DIR });
  if (buildCode !== 0) die("Build failed.");
  info("Build complete.");
}

// ── Asset upload ───────────────────────────────────────────────────────────

/** Recursively list all files under a directory, returning relative paths. */
function walkDir(dir: string, base?: string): string[] {
  const results: string[] = [];
  const root = base ?? dir;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, root));
    } else {
      results.push("/" + relative(root, fullPath));
    }
  }
  return results;
}

/** Map file extension to MIME content type for asset uploads. */
function mimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
    ".xml": "application/xml",
    ".txt": "text/plain",
    ".webmanifest": "application/manifest+json",
    ".map": "application/json",
    ".wasm": "application/wasm",
  };
  return types[ext] ?? "application/octet-stream";
}

/**
 * Compute the asset hash used by Cloudflare's Workers Assets API.
 * Algorithm: sha256(base64(fileContent) + extensionWithoutDot).hex().slice(0, 32)
 */
function assetHash(content: Buffer, filePath: string): string {
  const ext = extname(filePath).substring(1); // "html", "js", "css", etc.
  const b64 = content.toString("base64");
  return createHash("sha256")
    .update(b64 + ext)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Returns true for file types where we can safely append a comment to
 * force unique content on every deploy. Binary files are left untouched.
 */
function isTextAsset(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return [".js", ".mjs", ".css", ".html", ".svg", ".xml", ".json", ".txt", ".webmanifest", ".map"].includes(ext);
}

/**
 * Append a deploy nonce comment to text asset content.
 * This produces unique content per deploy, which generates unique Cloudflare
 * asset hashes. Without this, Cloudflare reuses cached assets from prior
 * uploads that may have broken (empty) Content-Type headers.
 *
 * Comment syntax is chosen per file type to be syntactically valid:
 *   JS/MJS/JSON/MAP: appends a trailing newline (nonce in hash only)
 *   CSS/HTML/SVG/XML: uses language-appropriate comment syntax
 *   Others: no modification (binary safe)
 */
function applyDeployNonce(content: Buffer, filePath: string, nonce: string): Buffer {
  if (!isTextAsset(filePath)) return content;

  const ext = extname(filePath).toLowerCase();
  let suffix: string;
  switch (ext) {
    case ".js":
    case ".mjs":
      suffix = `\n/* deploy:${nonce} */`;
      break;
    case ".css":
      suffix = `\n/* deploy:${nonce} */`;
      break;
    case ".html":
    case ".svg":
    case ".xml":
      suffix = `\n<!-- deploy:${nonce} -->`;
      break;
    case ".json":
    case ".map":
    case ".webmanifest":
    case ".txt":
      // Can't add comments to JSON safely; append a newline with the nonce
      // encoded into the content length change. The nonce lives in the hash
      // via the length difference.
      suffix = `\n`;
      break;
    default:
      return content;
  }

  return Buffer.concat([content, Buffer.from(suffix, "utf-8")]);
}

interface AssetManifest {
  [path: string]: { hash: string; size: number };
}

/**
 * Build the asset manifest for all files in dist/client/.
 *
 * A deploy nonce is appended to text-based assets so every deploy produces
 * unique hashes, forcing Cloudflare to re-accept all files with correct
 * Content-Type headers (see applyDeployNonce).
 */
function buildAssetManifest(nonce: string): { manifest: AssetManifest; contentMap: Map<string, Buffer> } {
  if (!existsSync(CLIENT_DIR)) die("No dist/client/ directory found. Run a build first.");

  const manifest: AssetManifest = {};
  const contentMap = new Map<string, Buffer>();
  const files = walkDir(CLIENT_DIR);

  for (const relativePath of files) {
    // Skip hidden files like .assetsignore
    const basename = relativePath.split("/").pop()!;
    if (basename.startsWith(".")) continue;

    const fullPath = join(CLIENT_DIR, relativePath);
    const rawContent = readFileSync(fullPath);
    const content = applyDeployNonce(rawContent, relativePath, nonce);

    manifest[relativePath] = {
      hash: assetHash(content, relativePath),
      size: content.length,
    };
    contentMap.set(relativePath, content);
  }

  return { manifest, contentMap };
}

/**
 * Upload static assets to Cloudflare Workers Assets.
 *
 * 1. Create upload session with manifest → get buckets + JWT
 * 2. Upload each bucket of files via multipart/form-data with per-file Content-Type
 * 3. Return completion JWT for use in worker deploy
 *
 * IMPORTANT: We use raw fetch() for step 2 instead of the SDK's
 * workers.assets.upload.create() because the SDK sends file content as plain
 * string form fields with no per-part Content-Type. Cloudflare uses the
 * Content-Type of each multipart part when serving the asset, so without it
 * all assets get served with an empty MIME type — breaking JS/CSS loading.
 *
 * The fix: send each file as a File object in the FormData so the multipart
 * encoding includes the correct Content-Type header for each part. This
 * matches what wrangler does internally (see workers-sdk PR #6618).
 *
 * A deploy nonce is injected into text assets so every deploy gets unique
 * hashes, preventing Cloudflare from reusing cached assets that may have
 * broken Content-Type headers from a prior upload.
 */
async function uploadAssets(accountId: string): Promise<string> {
  const client = await getClient();

  // Generate a unique nonce per deploy to force fresh asset hashes.
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  info(`Deploy nonce: ${nonce}`);

  const { manifest, contentMap } = buildAssetManifest(nonce);
  const fileCount = Object.keys(manifest).length;
  info(`Asset manifest: ${fileCount} files.`);

  // Step 1: Create upload session (SDK is fine here — just sends the manifest)
  info("Creating asset upload session...");
  const session = await client.workers.scripts.assets.upload.create(WORKER_NAME, {
    account_id: accountId,
    manifest,
  });

  const buckets = session.buckets ?? [];
  let completionJwt = session.jwt ?? "";

  if (buckets.length === 0) {
    info("All assets already uploaded (no new files to transfer).");
    return completionJwt;
  }

  // Build a reverse lookup: hash → relative path
  const hashToPath: Record<string, string> = {};
  for (const [path, { hash }] of Object.entries(manifest)) {
    hashToPath[hash] = path;
  }

  // Step 2: Upload each bucket via raw fetch with multipart/form-data
  // Each file part must have the correct Content-Type so Cloudflare serves
  // the asset with that MIME type.
  const uploadUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/assets/upload?base64=true`;

  info(`Uploading assets in ${buckets.length} bucket(s)...`);
  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i];
    const form = new FormData();

    for (const hash of bucket) {
      const relativePath = hashToPath[hash];
      if (!relativePath) die(`Asset hash ${hash} not found in manifest.`);

      // Use the nonce-appended content from the manifest build, NOT the raw file.
      const content = contentMap.get(relativePath);
      if (!content) die(`Content for ${relativePath} not found in content map.`);
      const b64 = content.toString("base64");
      const contentType = mimeType(relativePath);

      // Create a File object so the multipart part carries the correct Content-Type.
      // Cloudflare uses this Content-Type header when serving the asset to browsers.
      form.append(hash, new File([b64], hash, { type: contentType }));
    }

    info(`  Bucket ${i + 1}/${buckets.length}: ${bucket.length} file(s)...`);
    const resp = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${completionJwt}` },
      body: form,
    });

    if (!resp.ok) {
      const body = await resp.text();
      die(`Asset upload failed (HTTP ${resp.status}): ${body}`);
    }

    const result = (await resp.json()) as { result?: { jwt?: string } };
    if (result.result?.jwt) {
      completionJwt = result.result.jwt;
    }
  }

  info("Asset upload complete.");
  return completionJwt;
}

// ── Worker deploy ──────────────────────────────────────────────────────────

/**
 * Deploy the Worker via the Cloudflare SDK.
 *
 * Uploads all server modules (entry.mjs + chunks/*.mjs) with metadata
 * including bindings, compatibility settings, and the asset completion JWT.
 */
async function deployWorker(
  accountId: string,
  dbId: string,
  domain: string | undefined,
  assetJwt: string,
): Promise<void> {
  const client = await getClient();
  info("Deploying worker...");

  // Collect all server modules
  if (!existsSync(ENTRY_MODULE)) die("No dist/server/entry.mjs found. Run a build first.");

  const serverFiles = walkDir(SERVER_DIR, SERVER_DIR);
  const modules: Awaited<ReturnType<typeof toFile>>[] = [];

  for (const relPath of serverFiles) {
    // Skip wrangler.json — not needed for SDK deploy
    if (relPath.endsWith("wrangler.json")) continue;

    const fullPath = join(SERVER_DIR, relPath.startsWith("/") ? relPath.slice(1) : relPath);
    const content = readFileSync(fullPath);
    const moduleName = relPath.startsWith("/") ? relPath.slice(1) : relPath;

    modules.push(
      await toFile(content, moduleName, {
        type: "application/javascript+module",
      }),
    );
  }

  info(`  ${modules.length} module(s) to upload.`);

  // Build bindings
  const bindings: Array<Record<string, unknown>> = [
    { type: "d1", name: "DB", id: dbId },
    { type: "assets", name: "ASSETS" },
  ];

  // Deploy via scripts.update() — uploads + deploys in one step
  await client.workers.scripts.update(WORKER_NAME, {
    account_id: accountId,
    metadata: {
      main_module: "entry.mjs",
      assets: { jwt: assetJwt },
      bindings: bindings as any,
      compatibility_date: COMPAT_DATE,
      compatibility_flags: COMPAT_FLAGS,
    },
    files: modules,
  });

  info("Worker deployed.");

  // Set up custom domain route if configured
  if (domain) {
    info(`Configuring custom domain: ${domain}...`);
    try {
      await client.workers.domains.update({
        account_id: accountId,
        environment: "production",
        hostname: domain,
        service: WORKER_NAME,
        zone_id: await getZoneId(domain),
      });
      info("Custom domain configured.");
    } catch (e) {
      if (e instanceof APIError && e.status === 409) {
        // Domain is attached to a different worker — find and offer to override
        info(`Custom domain '${domain}' is already attached to another worker.`);
        try {
          const existingDomains = await client.workers.domains.list({ account_id: accountId });
          const conflict = existingDomains.result?.find(
            (d: any) => d.hostname === domain,
          );
          if (conflict) {
            info(`  Currently owned by: ${(conflict as any).service || "unknown"}`);
            const answer = await ask(
              `Detach '${domain}' from '${(conflict as any).service || "other worker"}' and attach to '${WORKER_NAME}'? (yes/no)`,
            );
            if (answer === "yes") {
              await client.workers.domains.delete((conflict as any).id, { account_id: accountId });
              info("Old domain attachment removed.");
              await client.workers.domains.update({
                account_id: accountId,
                environment: "production",
                hostname: domain,
                service: WORKER_NAME,
                zone_id: await getZoneId(domain),
              });
              info("Custom domain configured.");
            } else {
              info("Skipping custom domain setup. Worker is deployed but reachable only at workers.dev URL.");
            }
          } else {
            info("Could not find the conflicting domain entry. Skipping custom domain setup.");
            info("You may need to resolve this manually in the Cloudflare dashboard.");
          }
        } catch (inner) {
          info(`Warning: could not resolve domain conflict: ${inner}`);
          info("Worker is deployed, but custom domain needs manual configuration.");
        }
      } else {
        formatApiError(e, "worker custom domain");
      }
    }
  }
}

/**
 * Set cron triggers for the Worker.
 */
async function setupCronTriggers(accountId: string): Promise<void> {
  const client = await getClient();
  info("Setting cron triggers...");
  await client.workers.scripts.schedules.update(WORKER_NAME, {
    account_id: accountId,
    body: [{ cron: CRON_SCHEDULE }],
  });
  info(`Cron trigger set: ${CRON_SCHEDULE}`);
}

/**
 * Delete the Worker via the Cloudflare SDK.
 */
async function deleteWorker(accountId: string): Promise<void> {
  const client = await getClient();
  info(`Deleting worker '${WORKER_NAME}'...`);
  try {
    await client.workers.scripts.delete(WORKER_NAME, {
      account_id: accountId,
      force: true,
    });
    info("Worker deleted.");
  } catch (e) {
    if (e instanceof APIError && e.status === 404) {
      info("Worker not found (may already be deleted).");
    } else {
      info(`Warning: could not delete worker: ${e}`);
    }
  }
}

// ── Access setup ───────────────────────────────────────────────────────────

interface AccessSetupOptions {
  domain: string;
  zoneId: string;
  accountId: string;
}

/**
 * Prompt the user to choose an access policy and return the include rules.
 *
 * Options:
 *   1) Specific emails
 *   2) Email domain
 *   3) Access Group (recommended — restricts to team members)
 *   4) Allow everyone (WARNING: any email with OTP can access)
 */
async function promptAccessPolicy(accountId: string): Promise<AccessRule[]> {
  const client = await getClient();

  console.log("\nHow should dashboard access be controlled?");
  console.log("  1) Allow specific email addresses (e.g. user@example.com)");
  console.log("  2) Allow an email domain (e.g. everyone@example.com)");
  console.log("  3) Allow an Access Group (Recommended)");
  console.log("  4) Allow everyone (WARNING: any email that can receive an OTP gets access)");
  console.log("");
  const choice = await ask("Choice [1/2/3/4]");

  let includeRules: AccessRule[];

  switch (choice) {
    case "1": {
      const emails = await ask("Allowed emails (comma-separated)");
      if (!emails) die("At least one email is required.");
      includeRules = emails.split(",").map((e) => ({
        email: { email: e.trim() },
      }));
      break;
    }
    case "2": {
      const emailDomain = await ask("Allowed email domain (without @)");
      if (!emailDomain) die("Email domain is required.");
      includeRules = [{ email_domain: { domain: emailDomain } }];
      break;
    }
    case "3": {
      // List available Access Groups
      info("Fetching Access Groups...");
      const groups: Array<{ id: string; name: string }> = [];
      for await (const group of client.zeroTrust.access.groups.list({ account_id: accountId })) {
        if (group.id && group.name) {
          groups.push({ id: group.id, name: group.name });
        }
      }

      if (groups.length === 0) {
        die(
          "No Access Groups found in your account.\n\n" +
            "Create one in the Zero Trust dashboard:\n" +
            "  1. Go to https://one.dash.cloudflare.com\n" +
            "  2. Navigate to Access > Access Groups > Add a Group\n" +
            "  3. Give it a name (e.g. your team or org name)\n" +
            "  4. Under Include, select 'Emails' and add the email addresses\n" +
            "     of people who should access the dashboard\n" +
            "     (or use 'Emails ending in' for a whole domain, e.g. example.com)\n" +
            "  5. Save the group\n\n" +
            "Then re-run this command.",
        );
      }

      console.log("\nAvailable Access Groups:");
      for (let i = 0; i < groups.length; i++) {
        console.log(`  ${i + 1}) ${groups[i].name} (${groups[i].id})`);
      }
      console.log("");
      const groupChoice = await ask(`Group number [1-${groups.length}]`);
      const groupIdx = parseInt(groupChoice, 10) - 1;
      if (isNaN(groupIdx) || groupIdx < 0 || groupIdx >= groups.length) {
        die(`Invalid choice. Please enter a number between 1 and ${groups.length}.`);
      }

      const selected = groups[groupIdx];
      info(`Selected group: ${selected.name}`);
      includeRules = [{ group: { id: selected.id } }];
      break;
    }
    case "4": {
      console.log("");
      console.log("  ⚠  WARNING: 'Allow everyone' means ANY email address that can");
      console.log("     receive a one-time-password will be able to access your dashboard.");
      console.log("     This does NOT restrict access to your Cloudflare team members.");
      console.log("     Consider using an Access Group (option 3) instead.");
      console.log("");
      const confirm = await ask("Type 'yes' to confirm");
      if (confirm !== "yes") {
        die("Aborted. Re-run and choose a more restrictive option.");
      }
      includeRules = [{ everyone: {} }];
      break;
    }
    default:
      die("Invalid choice. Please enter 1, 2, 3, or 4.");
  }

  return includeRules;
}

/**
 * Create Cloudflare Access application + policies (idempotent).
 *
 * Creates:
 *   1. Main app (whole domain) with user-chosen allow policy
 *   2. Bypass apps for public endpoints (/v1/events, /v1/health, /v1/doc)
 *
 * CF Access evaluates more-specific paths first, so the bypass apps
 * for /v1/events etc. take precedence over the main app.
 */
async function setupAccess({ domain, zoneId, accountId }: AccessSetupOptions): Promise<void> {
  const client = await getClient();
  info("Configuring Cloudflare Access protection...");
  info(`Zone ID: ${zoneId}`);

  // Check if main Access app already exists
  const existing = await client.zeroTrust.access.applications.list({ zone_id: zoneId });
  const existingApp = existing.result?.find(
    (app) => "domain" in app && app.domain === domain,
  );

  if (existingApp) {
    info(`Access application for '${domain}' already exists (${existingApp.id}), skipping.`);
    info("To change the access policy, run: bun run scripts/deploy.ts reconfigure-access");
    return;
  }

  const includeRules = await promptAccessPolicy(accountId);

  // Create main Access application
  info(`Creating Access application for '${domain}'...`);
  const app = await client.zeroTrust.access.applications.create({
    zone_id: zoneId,
    name: WORKER_NAME,
    domain,
    type: "self_hosted",
    session_duration: "24h",
    auto_redirect_to_identity: false,
    app_launcher_visible: true,
  });
  if (!app.id) die("Failed to create Access application.");
  info(`Access application created: ${app.id}`);

  // Create allow policy
  info("Creating allow policy...");
  await client.zeroTrust.access.applications.policies.create(app.id, {
    zone_id: zoneId,
    name: `${WORKER_NAME}-allow`,
    decision: "allow",
    include: includeRules,
    precedence: 1,
  });
  info("Allow policy created.");

  // Create bypass apps for public endpoints
  const publicPaths = [
    { path: "/v1/events", name: `${WORKER_NAME}-ingest` },
    { path: "/v1/health", name: `${WORKER_NAME}-health` },
    { path: "/v1/doc", name: `${WORKER_NAME}-docs` },
  ];

  for (const { path, name } of publicPaths) {
    info(`Creating bypass for ${path}...`);
    const pubApp = await client.zeroTrust.access.applications.create({
      zone_id: zoneId,
      name,
      domain: `${domain}${path}`,
      type: "self_hosted",
      session_duration: "24h",
    });
    if (!pubApp.id) die(`Failed to create Access app for ${path}.`);

    await client.zeroTrust.access.applications.policies.create(pubApp.id, {
      zone_id: zoneId,
      name: `${name}-bypass`,
      decision: "bypass",
      include: [{ everyone: {} }],
      precedence: 1,
    });
    info(`  Bypass created for ${path}.`);
  }
}

/** Remove all statsfactory Access applications (idempotent). */
async function teardownAccess(zoneId: string): Promise<void> {
  const client = await getClient();
  info("Removing Cloudflare Access applications...");

  const apps = await client.zeroTrust.access.applications.list({ zone_id: zoneId });
  const sfApps = (apps.result ?? []).filter(
    (app) => app.name?.startsWith(WORKER_NAME),
  );

  if (sfApps.length === 0) {
    info("No statsfactory Access applications found.");
    return;
  }

  for (const app of sfApps) {
    info(`Deleting Access application '${app.name}' (${app.id})...`);
    try {
      await client.zeroTrust.access.applications.delete(app.id!, { zone_id: zoneId });
    } catch (e) {
      info(`  Warning: could not delete ${app.id}: ${e}`);
    }
  }
  info("Access applications deleted.");
}

// ── Commands ───────────────────────────────────────────────────────────────

async function cmdInstall(): Promise<void> {
  info("Installing statsfactory...");

  const accountId = await getAccountId();
  info(`Account ID: ${accountId}`);

  // 1. D1 database (idempotent)
  const dbId = await ensureD1(accountId);

  // 2. Apply migrations
  info("Applying D1 migrations...");
  await applyMigrations(accountId, dbId);

  // 3. Gather config (prompt now, apply secrets after deploy when worker exists)
  const teamDomain = await getEnvOrAsk(
    "CF_ACCESS_TEAM_DOMAIN",
    "CF_ACCESS_TEAM_DOMAIN",
    [
      "Enter your Cloudflare Access team domain.",
      "This is the '<team>' part of <team>.cloudflareaccess.com.",
      "Find it at: https://one.dash.cloudflare.com -> Settings -> Custom Pages",
    ].join("\n"),
  );

  // 4. Custom domain + zone validation
  const customDomain = await getEnvOrAsk(
    "STATSFACTORY_DOMAIN",
    "Custom domain (e.g. stats.example.com)",
    [
      "Enter the custom domain for your statsfactory dashboard.",
      "This must be a subdomain of a zone in your Cloudflare account.",
    ].join("\n"),
  );

  info(`Looking up Cloudflare zone for '${customDomain}'...`);
  const zoneId = await getZoneId(customDomain);
  info(`Zone ID: ${zoneId}`);

  // 5. Write deploy config (gitignored)
  writeDeployConfig({ database_id: dbId, domain: customDomain });

  // 6. Download release bundle if --download was passed
  if (downloadVersion) {
    await downloadRelease(downloadVersion);
  }

  // 7. Build (if needed) and deploy via SDK
  await ensureBuild();
  const assetJwt = await uploadAssets(accountId);
  await deployWorker(accountId, dbId, customDomain, assetJwt);
  await setupCronTriggers(accountId);

  // 8. Set secrets (must be after deploy so the worker exists)
  await ensureSecret(accountId, "CF_ACCESS_TEAM_DOMAIN", teamDomain);

  // 9. Cloudflare Access (idempotent)
  await setupAccess({ domain: customDomain, zoneId, accountId });

  console.log("");
  info(`Done! statsfactory is deployed at https://${customDomain}`);
  info("");
  info(`Dashboard: https://${customDomain}`);
  info(`API docs:  https://${customDomain}/v1/doc`);
  info(`Health:    https://${customDomain}/v1/health`);
  info("");
  info("Next: create an app and API key via the dashboard.");
}

async function cmdUpgrade(): Promise<void> {
  info("Upgrading statsfactory...");

  const accountId = await getAccountId();

  // Resolve deploy config: file → env vars → D1 lookup by name
  let config = readDeployConfig();
  if (!config) {
    info("No deploy config file found, looking up D1 database by name...");
    const dbId = await ensureD1(accountId);
    const domain = process.env.STATSFACTORY_DOMAIN;
    config = { database_id: dbId, domain };
  }

  // Apply migrations
  info("Applying D1 migrations...");
  await applyMigrations(accountId, config.database_id);

  // Download release bundle if --download was passed
  if (downloadVersion) {
    await downloadRelease(downloadVersion);
  }

  // Build (if needed) and deploy via SDK
  await ensureBuild();
  const assetJwt = await uploadAssets(accountId);
  await deployWorker(accountId, config.database_id, config.domain, assetJwt);
  await setupCronTriggers(accountId);

  console.log("");
  info("Done! statsfactory has been upgraded.");
}

async function cmdDestroy(): Promise<void> {
  info("This will permanently delete the statsfactory worker, D1 database,");
  info("and Cloudflare Access configuration.");
  const confirm = await ask("Type 'yes' to confirm");
  if (confirm !== "yes") {
    console.log("Aborted.");
    process.exit(0);
  }

  const accountId = await getAccountId();

  // 1. Remove Access applications
  const config = readDeployConfig();
  if (config?.domain) {
    try {
      const zoneId = await getZoneId(config.domain);
      await teardownAccess(zoneId);
    } catch (e) {
      info(`Warning: could not clean up Access apps: ${e}`);
      info("You may need to manually remove them from the Zero Trust dashboard.");
    }
  } else {
    info("No deploy config found, skipping Access cleanup.");
  }

  // 2. Detach custom domains from the worker
  info("Detaching custom domains...");
  try {
    const client = await getClient();
    const allDomains = await client.workers.domains.list({ account_id: accountId });
    const workerDomains = (allDomains.result ?? []).filter(
      (d: any) => d.service === WORKER_NAME,
    );
    if (workerDomains.length === 0) {
      info("No custom domains found for this worker.");
    } else {
      for (const d of workerDomains) {
        info(`  Detaching '${(d as any).hostname}'...`);
        try {
          await client.workers.domains.delete((d as any).id, { account_id: accountId });
        } catch (e) {
          info(`  Warning: could not detach domain ${(d as any).hostname}: ${e}`);
        }
      }
      info("Custom domains detached.");
    }
  } catch (e) {
    info(`Warning: could not clean up custom domains: ${e}`);
  }

  // 3. Delete the worker via SDK
  await deleteWorker(accountId);

  // 4. Delete D1 database
  info(`Deleting D1 database '${DB_NAME}'...`);
  const destroyClient = await getClient();
  try {
    // Find the database
    for await (const db of destroyClient.d1.database.list({ account_id: accountId })) {
      if (db.name === DB_NAME && db.uuid) {
        await destroyClient.d1.database.delete(db.uuid, { account_id: accountId });
        info("D1 database deleted.");
        break;
      }
    }
  } catch (e) {
    info(`Warning: could not delete D1 database: ${e}`);
  }

  // 5. Remove the deploy config file
  removeDeployConfig();

  console.log("");
  info("Done. statsfactory has been destroyed.");
}

/**
 * Reconfigure the Cloudflare Access policy for an existing deployment.
 *
 * This allows changing who can access the dashboard without doing a full
 * destroy + install cycle. It:
 *   1. Finds the existing Access application for the domain
 *   2. Deletes the old allow policy
 *   3. Prompts for a new policy configuration
 *   4. Creates the new allow policy
 *
 * Bypass policies for public endpoints are left untouched.
 */
async function cmdReconfigureAccess(): Promise<void> {
  info("Reconfiguring Cloudflare Access policy...");

  const config = readDeployConfig();
  if (!config?.domain) {
    die(
      "No deploy config found. Run 'install' first.\n" +
        `Expected: ${DEPLOY_TOML}`,
    );
  }

  const accountId = await getAccountId();
  const domain = config.domain;
  info(`Domain: ${domain}`);

  const zoneId = await getZoneId(domain);
  info(`Zone ID: ${zoneId}`);

  const client = await getClient();

  // Find the main Access application (matches the bare domain, not subpaths)
  const apps = await client.zeroTrust.access.applications.list({ zone_id: zoneId });
  const mainApp = (apps.result ?? []).find(
    (app) => "domain" in app && app.domain === domain && app.name === WORKER_NAME,
  );

  if (!mainApp?.id) {
    die(
      `No Access application found for '${domain}'.\n` +
        "Run 'install' first to create the Access configuration.",
    );
  }

  info(`Found Access application: ${mainApp.name} (${mainApp.id})`);

  // List existing policies to find and remove the allow policy
  const policies = await client.zeroTrust.access.applications.policies.list(mainApp.id, {
    zone_id: zoneId,
  });
  const allowPolicy = (policies.result ?? []).find(
    (p) => p.name === `${WORKER_NAME}-allow`,
  );

  if (allowPolicy?.id) {
    // Show current policy details
    info(`Current allow policy: ${allowPolicy.name} (${allowPolicy.id})`);
    const currentInclude = allowPolicy.include ?? [];
    for (const rule of currentInclude) {
      if ("everyone" in rule) {
        info("  Current rule: Allow everyone (INSECURE)");
      } else if ("email" in rule) {
        info(`  Current rule: Email ${(rule as any).email.email}`);
      } else if ("email_domain" in rule) {
        info(`  Current rule: Domain ${(rule as any).email_domain.domain}`);
      } else if ("group" in rule) {
        info(`  Current rule: Access Group ${(rule as any).group.id}`);
      }
    }
    console.log("");

    info("Deleting old allow policy...");
    await client.zeroTrust.access.applications.policies.delete(mainApp.id, allowPolicy.id, {
      zone_id: zoneId,
    });
    info("Old policy deleted.");
  } else {
    info("No existing allow policy found. Creating a new one.");
  }

  // Prompt for new policy
  const includeRules = await promptAccessPolicy(accountId);

  // Create new allow policy
  info("Creating new allow policy...");
  await client.zeroTrust.access.applications.policies.create(mainApp.id, {
    zone_id: zoneId,
    name: `${WORKER_NAME}-allow`,
    decision: "allow",
    include: includeRules,
    precedence: 1,
  });

  console.log("");
  info("Access policy reconfigured successfully.");
  info(`Dashboard: https://${domain}`);
}

// ── Logs (tail) ───────────────────────────────────────────────────────────

/**
 * Stream real-time logs from the deployed Worker via a WebSocket tail.
 *
 * Uses the Cloudflare API to create a tail session, then connects to the
 * returned WebSocket URL. Logs are printed to stdout until Ctrl-C.
 */
async function cmdLogs(): Promise<void> {
  const client = await getClient();
  const accountId = await getAccountId();

  info(`Starting log tail for ${WORKER_NAME}...`);

  // Create a tail session — returns a WebSocket URL
  const tail = await client.workers.scripts.tail.create(WORKER_NAME, {
    account_id: accountId,
    body: {},
  });

  const tailId = tail.id;
  const wsUrl = tail.url;

  if (!wsUrl) die("No WebSocket URL returned from tail API.");

  info(`Tail session: ${tailId}`);
  info(`Connecting to WebSocket...`);
  info("Press Ctrl-C to stop.\n");

  const ws = new WebSocket(wsUrl);

  // Clean up on exit
  const cleanup = async () => {
    try {
      ws.close();
    } catch {}
    try {
      await client.workers.scripts.tail.delete(WORKER_NAME, tailId, {
        account_id: accountId,
      });
    } catch {}
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  ws.addEventListener("open", () => {
    // Send a filter message to get all events (no filtering)
    ws.send(JSON.stringify({ debug: false }));
  });

  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(String(event.data));

      // Format the log entry
      const ts = data.eventTimestamp
        ? new Date(data.eventTimestamp).toISOString()
        : new Date().toISOString();
      const outcome = data.outcome ?? "unknown";
      const method = data.event?.request?.method ?? "";
      const url = data.event?.request?.url ?? "";

      // Print request info
      if (method || url) {
        console.log(`[${ts}] ${outcome} ${method} ${url}`);
      }

      // Print console.log messages from the worker
      const logs = data.logs ?? [];
      for (const log of logs) {
        const level = (log.level ?? "log").toUpperCase().padEnd(5);
        const messages = (log.message ?? []).join(" ");
        console.log(`  ${level} ${messages}`);
      }

      // Print exceptions
      const exceptions = data.exceptions ?? [];
      for (const ex of exceptions) {
        console.error(`  ERROR ${ex.name}: ${ex.message}`);
      }
    } catch {
      // Raw message — print as-is
      console.log(String(event.data));
    }
  });

  ws.addEventListener("error", (event) => {
    console.error("WebSocket error:", event);
  });

  ws.addEventListener("close", () => {
    info("WebSocket closed.");
    process.exit(0);
  });

  // Keep the process alive
  await new Promise(() => {});
}

// ── Entrypoint ─────────────────────────────────────────────────────────────

// Strip --name <value>, --build, and --download[=value] from args to find the command
const cliArgs = process.argv.slice(2).filter((_, i, arr) => {
  if (arr[i] === "--name") return false;
  if (i > 0 && arr[i - 1] === "--name") return false;
  if (arr[i] === "--build") return false;
  if (arr[i] === "--download" || arr[i].startsWith("--download=")) return false;
  return true;
});
const command = cliArgs[0];
const downloadVersion = parseDownloadFlag();

if (INSTANCE_SUFFIX) {
  info(`Instance: ${WORKER_NAME} (DB: ${DB_NAME})`);
}

try {
  switch (command) {
    case "install":
      await cmdInstall();
      break;
    case "upgrade":
      await cmdUpgrade();
      break;
    case "reconfigure-access":
      await cmdReconfigureAccess();
      break;
    case "destroy":
      await cmdDestroy();
      break;
    case "logs":
      await cmdLogs();
      break;
    default:
      console.log("Usage: bun run scripts/deploy.ts <command> [--name <instance>]");
      console.log("");
      console.log("Commands:");
      console.log("  install              First-time setup: create D1, configure domain + Access, deploy");
      console.log("  upgrade              Apply new migrations, rebuild, redeploy");
      console.log("  reconfigure-access   Change who can access the dashboard (without redeploying)");
      console.log("  destroy              Delete worker, D1 database, and Access configuration");
      console.log("  logs                 Stream real-time logs from the deployed worker (Ctrl-C to stop)");
      console.log("");
      console.log("Options:");
      console.log("  --name <instance>  Instance name for multi-deploy (e.g. --name prod)");
      console.log("                     Creates worker 'statsfactory-prod', DB 'statsfactory-prod', etc.");
      console.log("                     Default: 'statsfactory' (no suffix)");
      console.log("  --build            Force rebuild even if dist/ already exists");
      console.log("                     (without this flag, a pre-built dist/ is reused as-is)");
      console.log("  --download[=VER]   Download a pre-built release before deploying");
      console.log("                     --download          Latest stable release");
      console.log("                     --download=snapshot Rolling snapshot from main");
      console.log("                     --download=v0.1.0   Specific version");
      console.log("");
      console.log("Environment variables (optional — will prompt if not set):");
      console.log("  CLOUDFLARE_API_TOKEN      API token (see README for required permissions)");
      console.log("  CF_ACCESS_TEAM_DOMAIN     Cloudflare Access team domain");
      console.log("  STATSFACTORY_DOMAIN       Custom domain (e.g. stats.example.com)");
      console.log("  STATSFACTORY_NAME         Instance name (same as --name flag)");
      console.log("  STATSFACTORY_D1_ID        D1 database ID (for CI — skips deploy config file)");
      process.exit(1);
  }
} catch (e: unknown) {
  if (e instanceof Error) {
    console.error(`Error: ${e.message}`);
  } else {
    console.error(e);
  }
  process.exit(1);
} finally {
  rl.close();
}
