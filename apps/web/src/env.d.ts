/// <reference path="../.astro/types.d.ts" />

/** Build-time version injected via Vite define in astro.config.mjs */
declare const __STATSFACTORY_VERSION__: string;

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
