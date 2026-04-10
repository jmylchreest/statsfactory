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

# ── Release ──────────────────────────────────────────────────────────

# Version files to update on release
version_files := "apps/web/package.json packages/sdk-ts/package.json"

# Auto-detect next version from latest git tag (patch bump)
latest_tag := `git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || echo ""`

# Bump patch version, update manifests, commit, and tag
# Usage: just release [version]
release version="":
    #!/usr/bin/env bash
    set -euo pipefail
    if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
        echo "Error: Working directory is dirty. Commit or stash your changes first."
        exit 1
    fi
    V="{{version}}"
    if [ -z "$V" ]; then
        LATEST="{{latest_tag}}"
        if [ -z "$LATEST" ]; then
            V="0.0.1"
        else
            MAJOR=$(echo "$LATEST" | sed 's/^v//' | cut -d. -f1)
            MINOR=$(echo "$LATEST" | sed 's/^v//' | cut -d. -f2)
            PATCH=$(echo "$LATEST" | sed 's/^v//' | cut -d. -f3)
            V="${MAJOR}.${MINOR}.$((PATCH + 1))"
        fi
    fi
    echo "$V" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "Error: version must be semver (e.g. 1.2.3), got: $V"; exit 1; }
    echo "Releasing v${V}..."
    for f in {{version_files}}; do
        sed -i "s/\"version\": *\"[^\"]*\"/\"version\": \"${V}\"/" "$f"
    done
    echo "Updated: {{version_files}}"
    bun install
    git add {{version_files}} bun.lock
    git commit -m "release: v${V}"
    git tag -a "v${V}" -m "v${V}"
    echo ""
    echo "Tagged v${V}. Push with:"
    echo "  git push origin main v${V}"

# Release and push in one step
release-push version="":
    #!/usr/bin/env bash
    set -euo pipefail
    just release "{{version}}"
    TAG=$(git describe --tags --abbrev=0)
    git push origin main "$TAG"

# Show current version (latest tag or snapshot)
get-version:
    #!/usr/bin/env bash
    set -euo pipefail
    LATEST="{{latest_tag}}"
    CURRENT_COMMIT=$(git rev-parse HEAD)
    if [ -z "$LATEST" ]; then
        SHORT=$(git rev-parse --short HEAD)
        echo "v0.0.1-${SHORT}-SNAPSHOT"
    else
        TAG_COMMIT=$(git rev-parse "${LATEST}^{commit}" 2>/dev/null)
        if [ "$CURRENT_COMMIT" = "$TAG_COMMIT" ]; then
            echo "$LATEST"
        else
            MAJOR=$(echo "$LATEST" | sed 's/^v//' | cut -d. -f1)
            MINOR=$(echo "$LATEST" | sed 's/^v//' | cut -d. -f2)
            PATCH=$(echo "$LATEST" | sed 's/^v//' | cut -d. -f3)
            NEXT="v${MAJOR}.${MINOR}.$((PATCH + 1))"
            SHORT=$(git rev-parse --short HEAD)
            if git diff --quiet 2>/dev/null; then
                echo "${NEXT}-${SHORT}-SNAPSHOT"
            else
                echo "${NEXT}-${SHORT}-SNAPSHOT-dirty"
            fi
        fi
    fi

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
