#!/usr/bin/env bash
# E2E harness for the self-hosted Obsidian sync system.
# Automates everything that CAN be automated (build + test + workspace staging),
# then hands off the manual Obsidian-GUI verification with everything pre-wired.
#
# Usage:
#   bash scripts/e2e.sh           # build, test, stage vaults (reuse existing .e2e data)
#   bash scripts/e2e.sh --clean   # also wipe the server data dir + vault notes (fresh run)
#
# Requires: cargo, node/npm on PATH. Safe to re-run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E="$ROOT/.e2e"
CLEAN=0
[ "${1:-}" = "--clean" ] && CLEAN=1

step() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }

step "Build server"
( cd "$ROOT/server" && cargo build )

step "Build plugin"
( cd "$ROOT/client" && npm run build >/dev/null 2>&1 && echo "client/main.js built" )

step "Automated tests (fail here = do NOT proceed to manual E2E)"
( cd "$ROOT/server" && cargo test )
( cd "$ROOT/client" && npx vitest run )

step "Stage E2E workspace at .e2e/"
mkdir -p "$E2E"
printf '*\n' > "$E2E/.gitignore"   # keep the whole scratch area out of git
if [ "$CLEAN" = 1 ]; then
  echo "--clean: wiping server data + vault notes"
  rm -rf "$E2E/data" "$E2E/vaultA" "$E2E/vaultB"
fi
mkdir -p "$E2E/data"

stage_vault() {
  local name="$1"
  local pdir="$E2E/$name/.obsidian/plugins/new-livesync"
  mkdir -p "$pdir"
  cp "$ROOT/client/main.js" "$ROOT/client/manifest.json" "$pdir/"
  # Pre-seed plugin settings so it auto-connects on open (no manual config).
  printf '{"serverUrl":"http://127.0.0.1:8789","username":"admin","password":"admin"}\n' > "$pdir/data.json"
  # Mark the plugin enabled for this vault.
  printf '["new-livesync"]\n' > "$E2E/$name/.obsidian/community-plugins.json"
  echo "  staged $name  ->  $E2E/$name"
}
stage_vault vaultA
stage_vault vaultB

step "READY — manual Obsidian verification"
cat <<EOF
1) Start the server in a separate terminal:

     cd "$ROOT/server" && DATA_ROOT="$E2E/data" BIND_ADDR=127.0.0.1:8789 SYNC_USER=admin SYNC_PASSWORD=admin cargo run

2) In Obsidian, "Open folder as vault" for BOTH (open two windows):

     $E2E/vaultA
     $E2E/vaultB

   If prompted, turn OFF Restricted Mode and confirm "New LiveSync" is enabled
   (Settings -> Community plugins). It should auto-connect (Server URL + admin/admin
   are pre-seeded); the status/console logs "New LiveSync connected".

3) Walk the scenario checklist in:  docs/design/e2e-process.md  (Manual scenarios)
   The server's live vault files are visible on disk at:  $E2E/data/vault/

Re-run 'bash scripts/e2e.sh --clean' to reset to an empty state.
EOF
