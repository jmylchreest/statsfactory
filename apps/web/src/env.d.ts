/// <reference path="../.astro/types.d.ts" />

interface CloudflareEnv {
  DB?: D1Database;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  ASSETS: Fetcher;
}

type Runtime = import("@astrojs/cloudflare").Runtime<CloudflareEnv>;

declare namespace App {
  interface Locals extends Runtime {}
}
