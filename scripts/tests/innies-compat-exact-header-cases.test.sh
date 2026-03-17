#!/usr/bin/env bash
set -euo pipefail

TEST_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${TEST_SCRIPT_DIR}/../.." && pwd)"
SCRIPT_PATH="${ROOT_DIR}/scripts/innies-compat-exact-header-cases.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file_exists() {
  local path="$1"
  [[ -f "$path" ]] || fail "expected file to exist: $path"
}

assert_file_contains() {
  local path="$1"
  local pattern="$2"
  if ! grep -Fq "$pattern" "$path"; then
    echo "Expected pattern not found in $path: $pattern" >&2
    echo "--- file contents ---" >&2
    cat "$path" >&2
    echo "---------------------" >&2
    exit 1
  fi
}

assert_file_not_contains() {
  local path="$1"
  local pattern="$2"
  if grep -Fq "$pattern" "$path"; then
    echo "Unexpected pattern found in $path: $pattern" >&2
    echo "--- file contents ---" >&2
    cat "$path" >&2
    echo "---------------------" >&2
    exit 1
  fi
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

COMPAT_BUNDLE="$TMP_DIR/compat-bundle"
DIRECT_BUNDLE="$TMP_DIR/direct-bundle"
mkdir -p "$COMPAT_BUNDLE" "$DIRECT_BUNDLE"

cat >"$COMPAT_BUNDLE/upstream-request.json" <<'JSON'
{
  "request_id": "req_issue80_compat",
  "target_url": "https://api.anthropic.com/v1/messages",
  "body_bytes": 398262,
  "body_sha256": "1717a039bed013d162eb47daead7f7eea440bccc6fb2719b9233142976e9a093",
  "headers": {
    "accept": "text/event-stream",
    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "x-request-id": "req_issue80_compat"
  }
}
JSON

cat >"$DIRECT_BUNDLE/direct-request.json" <<'JSON'
{
  "request_id": "req_issue80_direct",
  "target_url": "https://api.anthropic.com/v1/messages",
  "body_bytes": 398262,
  "body_sha256": "1717a039bed013d162eb47daead7f7eea440bccc6fb2719b9233142976e9a093",
  "headers": {
    "accept": "text/event-stream",
    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": "2023-06-01",
    "authorization": "Bearer secret-token",
    "content-type": "application/json",
    "user-agent": "OpenClawGateway/1.0",
    "x-app": "cli",
    "x-request-id": "req_issue80_direct"
  }
}
JSON

OUT_DIR="$TMP_DIR/out"
"$SCRIPT_PATH" "$COMPAT_BUNDLE" "$DIRECT_BUNDLE" "$OUT_DIR" >"$TMP_DIR/stdout.txt" 2>"$TMP_DIR/stderr.txt"

assert_file_exists "$OUT_DIR/summary.txt"
assert_file_exists "$OUT_DIR/cases/compat-exact.tsv"
assert_file_exists "$OUT_DIR/cases/direct-exact.tsv"
assert_file_exists "$OUT_DIR/cases/shared.tsv"
assert_file_exists "$OUT_DIR/cases/compat-with-direct-beta.tsv"
assert_file_exists "$OUT_DIR/cases/compat-with-direct-identity.tsv"
assert_file_exists "$OUT_DIR/cases/compat-with-direct-beta-and-identity.tsv"
assert_file_exists "$OUT_DIR/cases/compat-with-all-direct-deltas.tsv"

assert_file_contains "$OUT_DIR/cases/compat-exact.tsv" $'anthropic-beta\tfine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14'
assert_file_contains "$OUT_DIR/cases/direct-exact.tsv" $'anthropic-dangerous-direct-browser-access\ttrue'
assert_file_contains "$OUT_DIR/cases/direct-exact.tsv" $'user-agent\tOpenClawGateway/1.0'
assert_file_contains "$OUT_DIR/cases/shared.tsv" $'anthropic-version\t2023-06-01'
assert_file_contains "$OUT_DIR/cases/compat-with-direct-beta.tsv" $'anthropic-beta\tfine-grained-tool-streaming-2025-05-14'
assert_file_contains "$OUT_DIR/cases/compat-with-direct-identity.tsv" $'anthropic-dangerous-direct-browser-access\ttrue'
assert_file_contains "$OUT_DIR/cases/compat-with-direct-identity.tsv" $'x-app\tcli'
assert_file_not_contains "$OUT_DIR/cases/compat-with-direct-identity.tsv" 'authorization'
assert_file_contains "$OUT_DIR/cases/compat-with-direct-beta-and-identity.tsv" $'anthropic-beta\tfine-grained-tool-streaming-2025-05-14'
assert_file_contains "$OUT_DIR/cases/compat-with-direct-beta-and-identity.tsv" $'user-agent\tOpenClawGateway/1.0'
assert_file_contains "$OUT_DIR/cases/compat-with-all-direct-deltas.tsv" $'anthropic-beta\tfine-grained-tool-streaming-2025-05-14'
assert_file_contains "$OUT_DIR/cases/compat-with-all-direct-deltas.tsv" $'x-app\tcli'

assert_file_contains "$OUT_DIR/summary.txt" 'body_sha256_match=true'
assert_file_contains "$OUT_DIR/summary.txt" 'body_bytes_match=true'
assert_file_contains "$OUT_DIR/summary.txt" 'functional_value_mismatches=anthropic-beta'
assert_file_contains "$OUT_DIR/summary.txt" 'identity_direct_only_headers=anthropic-dangerous-direct-browser-access,user-agent,x-app'
assert_file_contains "$OUT_DIR/summary.txt" 'request_scoped_value_mismatches=x-request-id'

MISMATCH_BUNDLE="$TMP_DIR/direct-body-mismatch"
mkdir -p "$MISMATCH_BUNDLE"

cat >"$MISMATCH_BUNDLE/direct-request.json" <<'JSON'
{
  "request_id": "req_issue80_direct_mismatch",
  "target_url": "https://api.anthropic.com/v1/messages",
  "body_bytes": 398263,
  "body_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "headers": {
    "accept": "text/event-stream",
    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
    "anthropic-version": "2023-06-01"
  }
}
JSON

set +e
"$SCRIPT_PATH" "$COMPAT_BUNDLE" "$MISMATCH_BUNDLE" "$TMP_DIR/out-mismatch" >"$TMP_DIR/mismatch.stdout.txt" 2>"$TMP_DIR/mismatch.stderr.txt"
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  fail 'expected body mismatch invocation to fail'
fi

assert_file_contains "$TMP_DIR/mismatch.stderr.txt" 'body-held-constant mismatch'

echo 'PASS'
