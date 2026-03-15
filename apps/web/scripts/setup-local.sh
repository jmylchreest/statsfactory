#!/usr/bin/env bash
set -euo pipefail

# Local development setup for statsfactory.
# Starts a local libSQL HTTP server, pushes the DB schema, seeds data,
# and starts the Astro dev server.
#
# Usage:
#   bun run setup:local        (from apps/web/)
#   ./scripts/setup-local.sh   (directly)
#
# Prerequisites: bun (that's it!)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

DEV_VARS="$PROJECT_DIR/.dev.vars"
DB_PORT=8080

# ── 1. Create .dev.vars if missing ──────────────────────────────────
if [ ! -f "$DEV_VARS" ]; then
  echo "Creating .dev.vars from .dev.vars.example..."
  cp .dev.vars.example .dev.vars
fi

# Use file: URL for drizzle-kit and seed (they run in Bun, not Workers)
export TURSO_DATABASE_URL="file:local.db"

# ── 2. Push schema ─────────────────────────────────────────────────
echo ""
echo "Pushing database schema to local.db..."
bunx drizzle-kit push --force

# ── 3. Seed data ───────────────────────────────────────────────────
echo ""
echo "Seeding database..."
bun run scripts/seed.ts

# ── 4. Start local libSQL HTTP server (background) ─────────────────
echo ""
echo "Starting local libSQL HTTP server on port $DB_PORT..."
bun run scripts/dev-db.ts --port "$DB_PORT" --db local.db &
DB_PID=$!
trap "echo ''; echo 'Stopping libSQL server...'; kill $DB_PID 2>/dev/null || true" EXIT

# Wait for server to be ready
for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$DB_PORT/health" > /dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "Error: libSQL server failed to start on port $DB_PORT"
    exit 1
  fi
  sleep 0.3
done

# ── 5. Start Astro dev server ──────────────────────────────────────
echo ""
echo "============================================"
echo "  Local dev environment is ready!"
echo "  DB server: http://127.0.0.1:$DB_PORT"
echo "  DB file:   $PROJECT_DIR/local.db"
echo "============================================"
echo ""
echo "Starting Astro dev server..."
bun run dev
