#!/usr/bin/env bash
set -euo pipefail

# Local D1 development setup for statsfactory.
# Uses wrangler dev with a local D1 SQLite database.
#
# Usage:
#   bun run setup:d1     (from apps/web/)
#   ./scripts/setup-d1.sh
#
# Prerequisites: bun

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

D1_DIR="$PROJECT_DIR/.wrangler/state/v3/d1/local-dev"
DB_FILE="$D1_DIR/db.sqlite"

# ── 1. Ensure D1 local dir exists ──────────────────────────────────
mkdir -p "$D1_DIR"

# ── 2. Push schema via drizzle-kit (pointing at the D1 SQLite file) ─
echo ""
echo "Pushing database schema to local D1..."
TURSO_DATABASE_URL="file:$DB_FILE" bunx drizzle-kit push --force

# ── 3. Seed data ──────────────────────────────────────────────────
echo ""
echo "Seeding database..."
TURSO_DATABASE_URL="file:$DB_FILE" TURSO_AUTH_TOKEN="" bun run scripts/seed.ts

# ── 4. Done ──────────────────────────────────────────────────────
echo ""
echo "============================================"
echo "  D1 local dev environment is ready!"
echo "  DB file: $DB_FILE"
echo ""
echo "  Start with:  bun run dev:d1"
echo "  URL:         http://localhost:8787"
echo "============================================"
