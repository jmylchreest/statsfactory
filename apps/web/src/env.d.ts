/// <reference path="../.astro/types.d.ts" />

interface CloudflareEnv {
  DB: D1Database;
  ASSETS: Fetcher;
}

type Runtime = import("@astrojs/cloudflare").Runtime<CloudflareEnv>;

declare namespace App {
  interface Locals extends Runtime {}
}
