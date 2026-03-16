import { defineConfig, sessionDrivers } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  output: "server",
  adapter: cloudflare({
    entryPoint: "./src/worker-entry.ts",
    // Use passthrough — we don't use Cloudflare image transforms.
    imageService: "passthrough",
  }),
  // Use null session driver to prevent the Cloudflare adapter from
  // auto-provisioning a KV namespace. We don't use Astro sessions; our
  // "sessions" are analytics session_id values stored in D1.
  // See: https://github.com/withastro/astro/issues/15802
  session: {
    driver: sessionDrivers.null(),
  },
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
