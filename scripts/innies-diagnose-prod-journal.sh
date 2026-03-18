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
usage: innies-diagnose-prod-journal [options] [pattern...]

Fetch Innies prod journal logs from the devops API, save raw output, and
optionally filter locally by request id / process / error pattern.

generic env aliases:
  INNIES_DIAG_JOURNAL_HOST
  INNIES_DIAG_JOURNAL_USER
  INNIES_DIAG_JOURNAL_PASSWORD
EOF
  exit 0
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
fi

export DEVOPS_JOURNAL_HOST="${DEVOPS_JOURNAL_HOST:-${INNIES_DIAG_JOURNAL_HOST:-}}"
export DEVOPS_JOURNAL_USER="${DEVOPS_JOURNAL_USER:-${INNIES_DIAG_JOURNAL_USER:-}}"
export DEVOPS_JOURNAL_PASSWORD="${DEVOPS_JOURNAL_PASSWORD:-${INNIES_DIAG_JOURNAL_PASSWORD:-}}"

exec "${SCRIPT_DIR}/issue80-prod-journal.sh" "$@"
