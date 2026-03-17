#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-direct-header-tsv.sh"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

BUNDLE_DIR="$TMP_DIR/direct-bundle"
mkdir -p "$BUNDLE_DIR"

cat >"$BUNDLE_DIR/direct-request.json" <<'JSON'
{
  "request_id": "req_direct_good",
  "body_bytes": 393038,
  "body_sha256": "fe256e82a18beecd90f4b5d7d3ae788b42ff6b2cd2693b12d695fc415f1fc853",
  "target_url": "https://api.anthropic.com/v1/messages",
  "headers": {
    "accept": "text/event-stream",
    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
    "anthropic-version": "2023-06-01",
    "authorization": "Bearer <redacted>",
    "content-type": "application/json",
    "content-length": "393038",
    "host": "api.anthropic.com",
    "x-request-id": "req_direct_good",
    "user-agent": "OpenClawGateway/1.0",
    "x-app": "cli",
    "anthropic-dangerous-direct-browser-access": "true",
    ":authority": "api.anthropic.com"
  }
}
JSON

cat >"$BUNDLE_DIR/upstream-request.json" <<'JSON'
{
  "request_id": "req_wrong_source",
  "headers": {
    "accept": "text/plain",
    "x-request-id": "req_wrong_source",
    "user-agent": "wrong-source"
  }
}
JSON

STDOUT_PATH="$TMP_DIR/stdout.txt"
STDERR_PATH="$TMP_DIR/stderr.txt"

set +e
"$SCRIPT_PATH" "$BUNDLE_DIR" >"$STDOUT_PATH" 2>"$STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  cat "$STDERR_PATH" >&2
  exit 1
fi

DEFAULT_TSV="$BUNDLE_DIR/direct-headers.tsv"
DEFAULT_SUMMARY="$BUNDLE_DIR/direct-headers.summary.txt"
[[ -f "$DEFAULT_TSV" ]]
[[ -f "$DEFAULT_SUMMARY" ]]

cat >"$TMP_DIR/expected-default.tsv" <<'TSV'
accept	text/event-stream
anthropic-beta	fine-grained-tool-streaming-2025-05-14
anthropic-version	2023-06-01
content-type	application/json
x-request-id	req_direct_good
user-agent	OpenClawGateway/1.0
x-app	cli
anthropic-dangerous-direct-browser-access	true
TSV

diff -u "$TMP_DIR/expected-default.tsv" "$DEFAULT_TSV"
grep -q '^request_id=req_direct_good$' "$DEFAULT_SUMMARY"
grep -q '^body_bytes=393038$' "$DEFAULT_SUMMARY"
grep -q '^body_sha256=fe256e82a18beecd90f4b5d7d3ae788b42ff6b2cd2693b12d695fc415f1fc853$' "$DEFAULT_SUMMARY"
grep -q '^source_file=.*direct-request.json$' "$DEFAULT_SUMMARY"
grep -q '^headers_written=8$' "$DEFAULT_SUMMARY"
grep -q '^skipped_headers=:authority,authorization,content-length,host$' "$DEFAULT_SUMMARY"
grep -q '^out_file=.*direct-headers.tsv$' "$DEFAULT_SUMMARY"
grep -q '^summary_file=.*direct-headers.summary.txt$' "$STDOUT_PATH"

SINGLE_FILE="$TMP_DIR/known-good-direct.json"
CUSTOM_TSV="$TMP_DIR/nested/known-good-direct.tsv"
CUSTOM_SUMMARY="$TMP_DIR/nested/known-good-direct.summary.txt"

cat >"$SINGLE_FILE" <<'JSON'
{
  "request_id": "req_known_good_single",
  "body_bytes": 128,
  "body_sha256": "0d84f0df2f7bc42fca815f16d0f5a44f8a48b0afcefb2b3b31df0f8bc3cb60eb",
  "target_url": "https://api.anthropic.com/v1/messages",
  "headers": {
    "accept": "application/json",
    "anthropic-version": "2023-06-01",
    "authorization": "Bearer should-be-removed",
    "x-request-id": "req_known_good_single"
  }
}
JSON

set +e
"$SCRIPT_PATH" "$SINGLE_FILE" "$CUSTOM_TSV" >"$STDOUT_PATH" 2>"$STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  cat "$STDERR_PATH" >&2
  exit 1
fi

[[ -f "$CUSTOM_TSV" ]]
[[ -f "$CUSTOM_SUMMARY" ]]
cat >"$TMP_DIR/expected-custom.tsv" <<'TSV'
accept	application/json
anthropic-version	2023-06-01
x-request-id	req_known_good_single
TSV

diff -u "$TMP_DIR/expected-custom.tsv" "$CUSTOM_TSV"
grep -q '^request_id=req_known_good_single$' "$CUSTOM_SUMMARY"
grep -q '^headers_written=3$' "$CUSTOM_SUMMARY"
grep -q '^skipped_headers=authorization$' "$CUSTOM_SUMMARY"

INVALID_JSON="$TMP_DIR/invalid.json"
cat >"$INVALID_JSON" <<'JSON'
{"request_id":"req_missing_headers"}
JSON

set +e
"$SCRIPT_PATH" "$INVALID_JSON" >"$STDOUT_PATH" 2>"$STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  echo 'expected missing-headers invocation to fail' >&2
  exit 1
fi

grep -q 'missing headers object' "$STDERR_PATH"
