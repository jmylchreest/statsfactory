import { defineConfig } from "drizzle-kit";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  throw new Error(
    "TURSO_DATABASE_URL is required. Set it in .dev.vars or export it.",
  );
}

// Local file: URLs don't need an auth token.
const isLocal = url.startsWith("file:");

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "turso",
  dbCredentials: {
    url,
    authToken: isLocal ? undefined : authToken,
  },
});
