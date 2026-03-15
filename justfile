# statsfactory — local development recipes
# Usage: just <recipe>  (run `just --list` to see all recipes)
#
# Uses Cloudflare D1 (local SQLite via wrangler dev).

set dotenv-load := false

web := "apps/web"

# ── Setup ────────────────────────────────────────────────────────────

# First-time setup: install deps, create env, push schema, seed
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
    cd {{web}} && STATSFACTORY_DB_PATH="${abs_db}" bun run scripts/seed.ts

# ── Development ──────────────────────────────────────────────────────

# Build + serve with local D1 binding (port 8787)
run: build
    cd {{web}} && wrangler dev --config wrangler.dev.toml

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

# Upgrade dependencies (semver-compatible)
upgrade:
    bun update

# Upgrade dependencies including breaking changes (major versions)
upgrade-breaking:
    bun update --latest

# Clean build artifacts
clean:
    cd {{web}} && rm -rf dist .astro

# Clean everything (build + local D1 database)
clean-all: clean
    cd {{web}} && rm -rf .wrangler/state/v3/d1
