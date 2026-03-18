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
usage: innies-diagnose-local-replay <body.json>

Replay a saved Anthropic /v1/messages body against local Innies, pin Anthropic,
save response artifacts, and print DB evidence when available.

generic env aliases:
  INNIES_DIAG_REQUEST_ID
  INNIES_DIAG_IDEMPOTENCY_KEY
  INNIES_DIAG_ANTHROPIC_VERSION
  INNIES_DIAG_CALLER_ANTHROPIC_BETA
  INNIES_DIAG_PIN_PROVIDER
  INNIES_DIAG_OUT_DIR
EOF
  exit 1
}

[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && usage
[[ $# -ge 1 ]] || usage

export ISSUE80_REQUEST_ID="${ISSUE80_REQUEST_ID:-${INNIES_DIAG_REQUEST_ID:-}}"
export ISSUE80_IDEMPOTENCY_KEY="${ISSUE80_IDEMPOTENCY_KEY:-${INNIES_DIAG_IDEMPOTENCY_KEY:-}}"
export ISSUE80_ANTHROPIC_VERSION="${ISSUE80_ANTHROPIC_VERSION:-${INNIES_DIAG_ANTHROPIC_VERSION:-}}"
export ISSUE80_CALLER_ANTHROPIC_BETA="${ISSUE80_CALLER_ANTHROPIC_BETA:-${INNIES_DIAG_CALLER_ANTHROPIC_BETA:-}}"
export ISSUE80_PIN_PROVIDER="${ISSUE80_PIN_PROVIDER:-${INNIES_DIAG_PIN_PROVIDER:-}}"
export ISSUE80_OUT_DIR="${ISSUE80_OUT_DIR:-${INNIES_DIAG_OUT_DIR:-}}"

exec "${SCRIPT_DIR}/issue80-local-replay.sh" "$@"
