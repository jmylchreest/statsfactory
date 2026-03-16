#!/usr/bin/env bash
# statsfactory deploy script — thin wrapper around scripts/deploy.ts
# Usage: ./deploy.sh install | upgrade | destroy
set -euo pipefail

die() { echo "Error: $*" >&2; exit 1; }

# Check for bun
command -v bun >/dev/null 2>&1 || die "bun is required. Install it: https://bun.sh"

# Ensure dependencies are installed (idempotent — skips if up to date)
if [ ! -d node_modules ] || [ ! -d apps/web/node_modules ]; then
  echo "==> Installing dependencies..."
  bun install
fi

# Ensure wrangler is authenticated (needed for build/deploy)
if ! bunx wrangler whoami >/dev/null 2>&1; then
  echo ""
  echo "Wrangler is not authenticated. Running 'wrangler login'..."
  echo "This opens a browser window to authorise wrangler with Cloudflare."
  echo ""
  bunx wrangler login || die "wrangler login failed."
fi

# Delegate to the TypeScript deploy script
exec bun run scripts/deploy.ts "$@"
