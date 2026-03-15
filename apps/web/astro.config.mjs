import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  output: "server",
  adapter: cloudflare({
    entryPoint: "./src/worker-entry.ts",
  }),
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
