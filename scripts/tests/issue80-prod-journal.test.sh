#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../issue80-prod-journal.sh"

assert_eq() {
  local actual="$1"
  local expected="$2"
  if [[ "$actual" != "$expected" ]]; then
    echo "assert_eq failed" >&2
    echo "actual:   $actual" >&2
    echo "expected: $expected" >&2
    exit 1
  fi
}

main() {
  assert_eq \
    "$(build_journal_url 'https://admin.spicefi.xyz' 'prod' 'innies-api' '2026-03-17T00:00:00Z')" \
    'https://admin.spicefi.xyz/devops/v1/journal?env=prod&unit=innies-api&since=2026-03-17T00:00:00Z'

  assert_eq \
    "$(build_journal_url 'https://admin.spicefi.xyz/' 'prod' 'innies-api' '')" \
    'https://admin.spicefi.xyz/devops/v1/journal?env=prod&unit=innies-api'
}

main "$@"
