import { defineConfig, sessionDrivers } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "child_process";

/**
 * Determine the build version.
 *
 * Priority: STATSFACTORY_VERSION env var (set by CI) > git describe > "dev"
 *
 * Version format (same algorithm as rosec):
 *   Tag push:   "0.1.0"
 *   Snapshot:   "0.1.1-dev.5+abc1234"
 *   Local dev:  "0.1.1-dev.5+abc1234" or "dev" if no git tags
 */
function resolveVersion() {
  if (process.env.STATSFACTORY_VERSION) return process.env.STATSFACTORY_VERSION;

  try {
    const describe = execSync("git describe --tags --always --long 2>/dev/null", {
      encoding: "utf-8",
    }).trim();
    const match = describe.match(
      /^v(\d+)\.(\d+)\.(\d+)-(\d+)-g([a-f0-9]+)$/,
    );
    if (match) {
      const [, major, minor, patch, commits, hash] = match;
      if (commits === "0") return `${major}.${minor}.${patch}`;
      const nextPatch = Number(patch) + 1;
      return `${major}.${minor}.${nextPatch}-dev.${commits}+${hash}`;
    }
    // No semver tags — just a bare hash from --always
    return `0.0.0-dev.0+${describe}`;
  } catch {
    return "dev";
  }
}

const version = resolveVersion();

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
    define: {
      __STATSFACTORY_VERSION__: JSON.stringify(version),
    },
  },
});
