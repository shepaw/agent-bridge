#!/usr/bin/env bash
# One-shot setup for the `deepseek-harness` engine: install a stable `dsh` CLI
# and pnpm globally, build the shepaw-dsh-plugin, and configure a `shepaw` dsh
# profile so Agent Hub can spawn `dsh --profile shepaw` directly.
#
# Usage:
#   bash scripts/setup-deepseek-harness.sh
#
# The model + DEEPSEEK_API_KEY are NOT touched here — they are read from the
# existing home-level dsh state (~/.dsh/settings.yaml + ~/.dsh/.credentials.yaml),
# so this reuses whatever dsh setup already works for `dsh web` / `dsh --profile headless`.

set -euo pipefail

DSH_VERSION="${DSH_VERSION:-0.1.1-rc.2}"
PROFILE="${DSH_SHEPAW_PROFILE:-shepaw}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/implementations/dsh-shepaw-plugin"

say() { printf '\n\033[1m==>\033[0m %s\n' "$*"; }

# ── 1. Fix the npm cache ownership bug (root-owned files from old npm/sudo runs).
say "Checking ~/.npm ownership…"
if [ -d "$HOME/.npm" ] && [ -n "$(find "$HOME/.npm" -not -user "$(id -u)" -print -quit 2>/dev/null)" ]; then
  echo "  root-owned files detected — fixing (may prompt for sudo)…"
  sudo chown -R "$(id -u):$(id -g)" "$HOME/.npm"
else
  echo "  already clean."
fi

# ── 2. Install a stable dsh CLI + pnpm (user-level global install, no sudo).
say "Installing dsh@${DSH_VERSION} and pnpm globally…"
npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" pnpm

# ── 3. Build the shepaw-dsh-plugin (produces implementations/dsh-shepaw-plugin/dist).
say "Building shepaw-dsh-plugin…"
if [ ! -f "$PLUGIN_DIR/package.json" ]; then
  echo "error: plugin not found at $PLUGIN_DIR" >&2
  exit 1
fi
(cd "$PLUGIN_DIR" && npm run build)

# ── 4. Configure the `shepaw` profile: `dsh plugin add` creates the profile on
#      first use (dsh-base + the plugin bundle), installs the plugin, and
#      auto-wires it into dsh.profile.bundles because it declares dsh.bundle.
#      Re-run on every setup so the profile picks up rebuilt plugin dist/.
say "Configuring dsh profile '${PROFILE}'…"
dsh plugin --profile "${PROFILE}" add "file:${PLUGIN_DIR}"

# ── 5. Verify the bridge mounts.
say "Verifying…"
if dsh --profile "${PROFILE}" --dump-config 2>&1 | grep -q 'shepaw-bridge'; then
  echo "  ✓ shepaw-bridge is mounted in profile '${PROFILE}'."
else
  echo "  ⚠ shepaw-bridge not found in the composed tree — check ~/.dsh/profiles/${PROFILE}/."
fi

cat <<EOF

Done. The engine is ready — create and start a deepseek-harness instance:

  shepaw-hub quickstart --engine deepseek-harness --yes
  # or
  shepaw-hub instance add --engine deepseek-harness --cwd ~/your-project
  shepaw-hub start <instance-id>

The Shepaw app pairs once against the Peer channel (shepaw://peer QR); the DSH
instance reuses that same peer identity, so no second scan is needed.

To upgrade DSH later: npm install -g @deepseek-ai/dsh@latest
(Hub uses whatever \`dsh\` is on PATH — see implementations/dsh-shepaw-plugin/README.md § DSH 版本与自升级)
EOF
