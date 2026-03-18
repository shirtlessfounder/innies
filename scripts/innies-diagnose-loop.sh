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
  cat <<'EOF'
usage: innies-diagnose-loop <subcommand> [args...]

Reusable diagnosis-loop entrypoint.

subcommands:
  help                       show this message
  runbook                    print the diagnosis runbook path
  prod-journal [args...]     fetch/filter prod journal logs
  local-replay <body.json>   replay a saved Anthropic body against local Innies
  direct-anthropic <args>    replay the same body directly to Anthropic
  anthropic-pool [--all]     inspect Anthropic token-pool eligibility inputs

autonomy boundary:
  local edits/tests: allowed
  prod probes/logs: read-only
  EC2 probes: read-only
  deploy/push: never automatic

see also:
  docs/ops/INNIES_DIAGNOSIS_LOOP.md
  docs/slash-commands/diagnose-innies-loop.md
EOF
}

subcommand="${1:-help}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "$subcommand" in
  help|--help|-h)
    usage
    ;;
  runbook)
    printf '%s\n' "${SCRIPT_DIR%/scripts}/docs/ops/INNIES_DIAGNOSIS_LOOP.md"
    ;;
  prod-journal)
    exec "${SCRIPT_DIR}/innies-diagnose-prod-journal.sh" "$@"
    ;;
  local-replay)
    exec "${SCRIPT_DIR}/innies-diagnose-local-replay.sh" "$@"
    ;;
  direct-anthropic)
    exec "${SCRIPT_DIR}/innies-diagnose-direct-anthropic.sh" "$@"
    ;;
  anthropic-pool)
    exec "${SCRIPT_DIR}/innies-diagnose-anthropic-pool.sh" "$@"
    ;;
  *)
    echo "error: unknown subcommand: ${subcommand}" >&2
    usage >&2
    exit 1
    ;;
esac
