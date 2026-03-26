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

assert_contains() {
  local haystack="$1"
  local needle="$2"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "assert_contains failed" >&2
    echo "haystack: $haystack" >&2
    echo "needle:   $needle" >&2
    exit 1
  fi
}

main() {
  DEVOPS_JOURNAL_HOST=''
  assert_eq \
    "$(resolve_journal_host 'https://journal.example')" \
    'https://journal.example'

  DEVOPS_JOURNAL_HOST='https://shared-config.example'
  assert_eq \
    "$(resolve_journal_host '')" \
    'https://shared-config.example'

  local stderr_file
  stderr_file="$(mktemp)"
  DEVOPS_JOURNAL_HOST=''
  if resolve_journal_host '' > /dev/null 2>"$stderr_file"; then
    echo 'resolve_journal_host should fail without env or --host' >&2
    rm -f "$stderr_file"
    exit 1
  fi
  assert_contains "$(cat "$stderr_file")" 'DEVOPS_JOURNAL_HOST or --host is required'
  rm -f "$stderr_file"

  assert_eq \
    "$(build_journal_url 'https://journal.example' 'prod' 'innies-api' '2026-03-17T00:00:00Z')" \
    'https://journal.example/devops/v1/journal?env=prod&unit=innies-api&since=2026-03-17T00:00:00Z'

  assert_eq \
    "$(build_journal_url 'https://journal.example/' 'prod' 'innies-api' '')" \
    'https://journal.example/devops/v1/journal?env=prod&unit=innies-api'
}

main "$@"
