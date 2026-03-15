# statsfactory — local development recipes
# Usage: just <recipe>  (run `just --list` to see all recipes)
#
# Default path uses Cloudflare D1 (local SQLite via wrangler dev).
# Turso/libSQL variants have a `-turso` suffix for fast HMR via Astro dev.

set dotenv-load := false

web := "apps/web"

# ── Setup (D1 — default) ────────────────────────────────────────────

# First-time setup: install deps, create env, push schema, seed (D1)
init: install setup-env setup-db setup-seed

# Install all dependencies
install:
    bun install

# Copy .dev.vars from example (safe — won't overwrite)
setup-env:
    @if [ ! -f {{web}}/.dev.vars ]; then \
        cp {{web}}/.dev.vars.example {{web}}/.dev.vars; \
        echo "Created {{web}}/.dev.vars"; \
    else \
        echo "{{web}}/.dev.vars already exists, skipping"; \
    fi

# Apply migrations to local D1 (creates the miniflare database)
setup-db:
    cd {{web}} && wrangler d1 migrations apply statsfactory --local --config wrangler.dev.toml

# Seed a test app + API key into local D1 (prints key to stdout)
setup-seed:
    #!/usr/bin/env bash
    set -euo pipefail
    # Find the miniflare D1 sqlite file (created by wrangler d1 migrations apply)
    db_file=$(find "{{web}}/.wrangler/state/v3/d1/miniflare-D1DatabaseObject" -name '*.sqlite' 2>/dev/null | head -1)
    if [ -z "$db_file" ]; then
        echo "Error: No D1 database found. Run 'just setup-db' first."
        exit 1
    fi
    abs_db="$(cd "$(dirname "$db_file")" && pwd)/$(basename "$db_file")"
    cd {{web}} && TURSO_DATABASE_URL="file:${abs_db}" TURSO_AUTH_TOKEN="" bun run scripts/seed.ts

# ── Setup (Turso — alternative) ─────────────────────────────────────

# First-time setup using local libSQL (Turso path)
init-turso: install setup-env setup-db-turso setup-seed-turso

# Push DB schema to local.db (Turso path)
setup-db-turso:
    cd {{web}} && TURSO_DATABASE_URL=file:local.db bunx drizzle-kit push --force

# Seed a test app + API key into local.db (Turso path)
setup-seed-turso:
    cd {{web}} && TURSO_DATABASE_URL=file:local.db bun run scripts/seed.ts

# ── Development (D1 — default) ──────────────────────────────────────

# Build + serve with local D1 binding (port 8787)
run: build
    cd {{web}} && wrangler dev --config wrangler.dev.toml

# ── Development (Turso — alternative) ───────────────────────────────

# Push schema + start libSQL HTTP server and Astro dev server (fast HMR)
run-turso: setup-db-turso
    #!/usr/bin/env bash
    set -euo pipefail
    cd {{web}}
    echo "Starting local libSQL HTTP server on port 8080..."
    bun run scripts/dev-db.ts --port 8080 --db local.db &
    DB_PID=$!
    trap "echo ''; echo 'Stopping libSQL server...'; kill $DB_PID 2>/dev/null || true" EXIT
    for i in $(seq 1 20); do
        if curl -sf "http://127.0.0.1:8080/health" > /dev/null 2>&1; then break; fi
        if [ "$i" -eq 20 ]; then echo "Error: libSQL server failed to start"; exit 1; fi
        sleep 0.3
    done
    echo "Starting Astro dev server..."
    bun run dev

# Start the local libSQL HTTP server only (port 8080)
run-db-turso:
    cd {{web}} && bun run scripts/dev-db.ts --port 8080 --db local.db

# Start the Astro dev server only (port 4321)
run-dev-turso:
    cd {{web}} && bun run dev

# ── Testing ──────────────────────────────────────────────────────────

# Run all tests (unit + integration)
test:
    cd {{web}} && bun run test

# Run tests in watch mode
test-watch:
    cd {{web}} && bun run test:watch

# ── Build ────────────────────────────────────────────────────────────

# Production build
build:
    cd {{web}} && bun run build

# Preview production build
preview:
    cd {{web}} && bun run preview

# ── Database ─────────────────────────────────────────────────────────

# Generate Drizzle migration files
db-generate:
    cd {{web}} && bun run db:generate

# Run pending migrations
db-migrate:
    cd {{web}} && bun run db:migrate

# Open Drizzle Studio GUI
db-studio:
    cd {{web}} && bun run db:studio

# ── Utilities ────────────────────────────────────────────────────────

# Send random test events to D1 dev server (port 8787)
# Usage: just send-event <key> [count] [event_name] [session_id]
send-event key count="" event="" session="":
    #!/usr/bin/env bash
    set -euo pipefail
    cmd="bun run scripts/send-events.ts {{key}} --port 8787"
    [ -n "{{count}}" ] && cmd="$cmd --count {{count}}"
    [ -n "{{event}}" ] && cmd="$cmd --event {{event}}"
    [ -n "{{session}}" ] && cmd="$cmd --session {{session}}"
    cd {{web}} && eval "$cmd"

# Send random test events to Turso dev server (port 4321)
# Usage: just send-event-turso <key> [count] [event_name] [session_id]
send-event-turso key count="" event="" session="":
    #!/usr/bin/env bash
    set -euo pipefail
    cmd="bun run scripts/send-events.ts {{key}} --port 4321"
    [ -n "{{count}}" ] && cmd="$cmd --count {{count}}"
    [ -n "{{event}}" ] && cmd="$cmd --event {{event}}"
    [ -n "{{session}}" ] && cmd="$cmd --session {{session}}"
    cd {{web}} && eval "$cmd"

# Upgrade dependencies (semver-compatible)
upgrade:
    bun update

# Upgrade dependencies including breaking changes (major versions)
upgrade-breaking:
    bun update --latest

# Clean build artifacts
clean:
    cd {{web}} && rm -rf dist .astro

# Clean everything (build + local D1 + local Turso DB)
clean-all: clean
    cd {{web}} && rm -rf .wrangler/state/v3/d1
    cd {{web}} && rm -f local.db local.db-journal
