#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  [[ "$haystack" == *"$needle"* ]] || fail "missing expected text: $needle"
}

main() {
  local help_output
  help_output="$("${ROOT_DIR}/scripts/innies-diagnose-loop.sh" help 2>&1)"
  assert_contains "$help_output" 'usage: innies-diagnose-loop <subcommand>'
  assert_contains "$help_output" 'prod-journal'
  assert_contains "$help_output" 'local-replay'
  assert_contains "$help_output" 'direct-anthropic'
  assert_contains "$help_output" 'anthropic-pool'

  local runbook_path
  runbook_path="$("${ROOT_DIR}/scripts/innies-diagnose-loop.sh" runbook)"
  [[ "$runbook_path" == *'/docs/ops/INNIES_DIAGNOSIS_LOOP.md' ]] || fail "unexpected runbook path: $runbook_path"
}

main "$@"
