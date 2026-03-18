#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="${SCRIPT_DIR}/${SCRIPT_PATH}"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"

usage() {
  cat >&2 <<'EOF'
usage: innies-diagnose-direct-anthropic <body.json> [beta_mode]

Replay the same Anthropic /v1/messages body directly to Anthropic for parity
comparison.

beta_mode:
  caller_only
  caller_plus_oauth   (default)
  oauth_only
  none

generic env aliases:
  INNIES_DIAG_DIRECT_BETA_MODE
  INNIES_DIAG_ANTHROPIC_BASE_URL
  INNIES_DIAG_ANTHROPIC_VERSION
  INNIES_DIAG_CALLER_ANTHROPIC_BETA
  INNIES_DIAG_OUT_DIR
EOF
  exit 1
}

[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && usage
[[ $# -ge 1 ]] || usage

export ISSUE80_DIRECT_BETA_MODE="${ISSUE80_DIRECT_BETA_MODE:-${INNIES_DIAG_DIRECT_BETA_MODE:-}}"
export ISSUE80_ANTHROPIC_BASE_URL="${ISSUE80_ANTHROPIC_BASE_URL:-${INNIES_DIAG_ANTHROPIC_BASE_URL:-}}"
export ISSUE80_ANTHROPIC_VERSION="${ISSUE80_ANTHROPIC_VERSION:-${INNIES_DIAG_ANTHROPIC_VERSION:-}}"
export ISSUE80_CALLER_ANTHROPIC_BETA="${ISSUE80_CALLER_ANTHROPIC_BETA:-${INNIES_DIAG_CALLER_ANTHROPIC_BETA:-}}"
export ISSUE80_OUT_DIR="${ISSUE80_OUT_DIR:-${INNIES_DIAG_OUT_DIR:-}}"

exec "${SCRIPT_DIR}/issue80-direct-anthropic.sh" "$@"
