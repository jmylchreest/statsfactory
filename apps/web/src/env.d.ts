/// <reference path="../.astro/types.d.ts" />

interface CloudflareEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  CF_ACCESS_TEAM_DOMAIN?: string;
  STATSFACTORY_DEV?: string;
}

type Runtime = import("@astrojs/cloudflare").Runtime<CloudflareEnv>;

declare namespace App {
  interface Locals extends Runtime {}
}
