#!/usr/bin/env bash
# statsfactory deploy script — thin wrapper around scripts/deploy.ts
#
# Uses the Cloudflare TypeScript SDK directly — no wrangler needed for deploy.
# Wrangler is only used at build time (bunx astro build) if dist/ is not pre-built.
#
# Usage: ./deploy.sh install | upgrade | reconfigure-access | destroy
set -euo pipefail

die() { echo "Error: $*" >&2; exit 1; }

# Check for bun
command -v bun >/dev/null 2>&1 || die "bun is required. Install it: https://bun.sh"

# Ensure dependencies are installed (idempotent — skips if up to date)
if [ ! -d node_modules ] || [ ! -d apps/web/node_modules ]; then
  echo "==> Installing dependencies..."
  bun install
fi

# Delegate to the TypeScript deploy script
exec bun run scripts/deploy.ts "$@"
