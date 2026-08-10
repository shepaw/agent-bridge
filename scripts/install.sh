#!/usr/bin/env bash
# Install Shepaw Agent Hub (and/or the ACP proxy gateway) from npm.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/shepaw/agent-bridge/main/scripts/install.sh | bash
#   curl -fsSL ... | bash -s -- --proxy-only
#   curl -fsSL ... | bash -s -- --skip-doctor
#
# Env overrides:
#   SHEPAW_INSTALL_TARGET=hub|proxy|all   (default: hub)
#   NPM_CONFIG_PREFIX=...                 custom npm global prefix

set -euo pipefail

TARGET="${SHEPAW_INSTALL_TARGET:-hub}"
SKIP_DOCTOR=0
NPM_ARGS=(-g)

usage() {
  cat <<'EOF'
install.sh — install Shepaw CLI tools via npm

Options:
  --hub-only      Install shepaw-agent-hub only (default)
  --proxy-only    Install shepaw-acp-proxy-gateway only
  --all           Install both
  --skip-doctor   Do not run `shepaw-hub doctor` after install
  -h, --help      Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub-only) TARGET=hub ;;
    --proxy-only) TARGET=proxy ;;
    --all) TARGET=all ;;
    --skip-doctor) SKIP_DOCTOR=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

info() { printf '==> %s\n' "$*"; }
warn() { printf 'warn: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

node_major_minor() {
  # prints "MAJOR MINOR" from `node -v` (e.g. v24.13.0 → "24 13")
  local v
  v="$(node -v 2>/dev/null || true)"
  v="${v#v}"
  local major="${v%%.*}"
  local rest="${v#*.}"
  local minor="${rest%%.*}"
  printf '%s %s\n' "${major:-0}" "${minor:-0}"
}

check_node() {
  need_cmd node
  need_cmd npm
  local major minor
  read -r major minor < <(node_major_minor)
  if (( major < 18 || (major == 18 && minor < 17) )); then
    die "Node.js >= 18.17 required (found $(node -v)). Install from https://nodejs.org or via nvm/fnm."
  fi
  info "Node $(node -v) · npm $(npm -v)"
}

install_pkg() {
  local pkg="$1"
  info "npm install -g ${pkg}"
  npm install "${NPM_ARGS[@]}" "$pkg"
}

main() {
  info "Shepaw install (target=${TARGET})"
  check_node

  case "$TARGET" in
    hub)
      install_pkg shepaw-agent-hub
      ;;
    proxy)
      install_pkg shepaw-acp-proxy-gateway
      ;;
    all)
      install_pkg shepaw-acp-proxy-gateway
      install_pkg shepaw-agent-hub
      ;;
    *)
      die "invalid SHEPAW_INSTALL_TARGET / target: ${TARGET}"
      ;;
  esac

  if command -v shepaw-hub >/dev/null 2>&1; then
    info "shepaw-hub → $(command -v shepaw-hub)"
    shepaw-hub --version 2>/dev/null || shepaw-hub -v 2>/dev/null || true
  fi
  if command -v shepaw-acp-proxy >/dev/null 2>&1; then
    info "shepaw-acp-proxy → $(command -v shepaw-acp-proxy)"
  fi

  if [[ "$TARGET" == "hub" || "$TARGET" == "all" ]]; then
    if [[ "$SKIP_DOCTOR" -eq 0 ]] && command -v shepaw-hub >/dev/null 2>&1; then
      info "Running shepaw-hub doctor…"
      # doctor exits 1 when hub.json is missing — that's expected pre-init.
      shepaw-hub doctor || true
    fi
    cat <<'EOF'

Next:
  shepaw-hub quickstart
  # or: shepaw-hub init && shepaw-hub doctor

Docs: https://github.com/shepaw/agent-bridge#readme
EOF
  else
    cat <<'EOF'

Next:
  shepaw-acp-proxy serve --engine claude-code --cwd ~/your-project --host 0.0.0.0
  shepaw-acp-proxy pair

Docs: https://github.com/shepaw/agent-bridge#readme
EOF
  fi
}

main
