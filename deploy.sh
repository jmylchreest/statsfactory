#!/usr/bin/env bash
# statsfactory deploy script
# Usage: ./deploy.sh install | upgrade | destroy
set -euo pipefail

WORKER_NAME="statsfactory"
DB_NAME="statsfactory"
WEB_DIR="apps/web"
WRANGLER_TOML="${WEB_DIR}/wrangler.toml"

# ── Helpers ─────────────────────────────────────────────────────────────────

die()  { echo "Error: $*" >&2; exit 1; }
info() { echo "==> $*"; }
ask()  { read -rp "$1: " "$2"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not found. Install it first."
}

require_wrangler_auth() {
  if ! wrangler whoami >/dev/null 2>&1; then
    die "Not authenticated with Cloudflare. Run 'wrangler login' first."
  fi
}

# ── Install ─────────────────────────────────────────────────────────────────

cmd_install() {
  info "Installing statsfactory..."
  require_cmd wrangler
  require_wrangler_auth

  # 1. Create D1 database
  info "Creating D1 database '${DB_NAME}'..."
  local create_output
  create_output=$(wrangler d1 create "${DB_NAME}" 2>&1) || {
    if echo "$create_output" | grep -q "already exists"; then
      info "Database '${DB_NAME}' already exists, reusing."
      create_output=$(wrangler d1 info "${DB_NAME}" 2>&1)
    else
      echo "$create_output" >&2
      die "Failed to create D1 database."
    fi
  }

  # Extract database_id
  local db_id
  db_id=$(echo "$create_output" | grep -oP '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  if [[ -z "$db_id" ]]; then
    die "Could not extract database_id from wrangler output. Output was:\n$create_output"
  fi
  info "Database ID: ${db_id}"

  # 2. Patch wrangler.toml with real database_id
  info "Updating wrangler.toml with database_id..."
  sed -i "s/database_id = \"local-dev\"/database_id = \"${db_id}\"/" "${WRANGLER_TOML}"

  # 3. Apply migrations
  info "Applying D1 migrations..."
  (cd "${WEB_DIR}" && wrangler d1 migrations apply "${DB_NAME}" --remote)

  # 4. Set secrets
  info "Setting secrets..."

  # CF_ACCESS_TEAM_DOMAIN
  local team_domain="${CF_ACCESS_TEAM_DOMAIN:-}"
  if [[ -z "$team_domain" ]]; then
    echo ""
    echo "Enter your Cloudflare Access team domain."
    echo "This is the '<team>' part of <team>.cloudflareaccess.com."
    echo "Find it at: https://one.dash.cloudflare.com → Settings → Custom Pages"
    ask "CF_ACCESS_TEAM_DOMAIN" team_domain
    echo ""
  fi
  [[ -n "$team_domain" ]] || die "CF_ACCESS_TEAM_DOMAIN is required."
  echo "$team_domain" | (cd "${WEB_DIR}" && wrangler secret put CF_ACCESS_TEAM_DOMAIN)

  # 5. Build and deploy
  info "Building..."
  (cd "${WEB_DIR}" && npx astro build)

  info "Deploying worker..."
  (cd "${WEB_DIR}" && wrangler deploy)

  echo ""
  info "Done! statsfactory is deployed."
  info "Next steps:"
  info "  1. Set up Cloudflare Access (Zero Trust) to protect the dashboard"
  info "  2. Create an app and API key via the dashboard or API"
  info "  See docs/deploy.md for details."
}

# ── Upgrade ─────────────────────────────────────────────────────────────────

cmd_upgrade() {
  info "Upgrading statsfactory..."
  require_cmd wrangler
  require_wrangler_auth

  # Check wrangler.toml has a real database_id
  if grep -q 'database_id = "local-dev"' "${WRANGLER_TOML}"; then
    die "wrangler.toml still has placeholder database_id. Run './deploy.sh install' first."
  fi

  # 1. Apply any new migrations
  info "Applying D1 migrations..."
  (cd "${WEB_DIR}" && wrangler d1 migrations apply "${DB_NAME}" --remote)

  # 2. Build and deploy
  info "Building..."
  (cd "${WEB_DIR}" && npx astro build)

  info "Deploying worker..."
  (cd "${WEB_DIR}" && wrangler deploy)

  echo ""
  info "Done! statsfactory has been upgraded."
}

# ── Destroy ─────────────────────────────────────────────────────────────────

cmd_destroy() {
  info "This will permanently delete the statsfactory worker and D1 database."
  read -rp "Are you sure? Type 'yes' to confirm: " confirm
  [[ "$confirm" == "yes" ]] || { echo "Aborted."; exit 0; }

  require_cmd wrangler
  require_wrangler_auth

  # 1. Delete the worker
  info "Deleting worker '${WORKER_NAME}'..."
  wrangler delete --name "${WORKER_NAME}" || info "Worker may already be deleted."

  # 2. Delete the D1 database
  info "Deleting D1 database '${DB_NAME}'..."
  wrangler d1 delete "${DB_NAME}" -y || info "Database may already be deleted."

  # 3. Reset wrangler.toml placeholder
  sed -i 's/database_id = "[^"]*"/database_id = "local-dev"/' "${WRANGLER_TOML}"

  echo ""
  info "Done. statsfactory has been destroyed."
}

# ── Entrypoint ──────────────────────────────────────────────────────────────

case "${1:-}" in
  install)  cmd_install ;;
  upgrade)  cmd_upgrade ;;
  destroy)  cmd_destroy ;;
  *)
    echo "Usage: $0 {install|upgrade|destroy}"
    echo ""
    echo "Commands:"
    echo "  install   First-time setup: create D1, apply schema, set secrets, deploy"
    echo "  upgrade   Apply new migrations and redeploy"
    echo "  destroy   Delete worker and D1 database"
    exit 1
    ;;
esac
