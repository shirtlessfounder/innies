#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-captured-lane-replay.sh"
TMP_DIR="$(mktemp -d)"
PAYLOAD_PATH="$TMP_DIR/payload.json"
CAPTURED_HTML_PATH="$TMP_DIR/response.html"
STDOUT_PATH="$TMP_DIR/stdout.txt"
STDERR_PATH="$TMP_DIR/stderr.txt"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat >"$PAYLOAD_PATH" <<'JSON'
{"model":"claude-opus-4-6","stream":true,"max_tokens":16,"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}
JSON

cat >"$CAPTURED_HTML_PATH" <<'LOG'
Mar 17 13:22:53 sf-prod bash[12345]: [compat-upstream-request-json-chunk] {
Mar 17 13:22:53 sf-prod bash[12345]:   chunk_index: 0,
Mar 17 13:22:53 sf-prod bash[12345]:   chunk_count: 1,
Mar 17 13:22:53 sf-prod bash[12345]:   json: '{"attempt_no":1,"credential_id":"cred_issue80","headers":{"accept":"text/event-stream","authorization":"Bearer <redacted:108>","content-type":"application/json","x-request-id":"req_issue80_captured"},"provider":"openai","proxied_path":"/v1/messages","request_id":"req_issue80_captured","stream":true,"target_url":"https://chatgpt.com/backend-api/codex/responses"}'
Mar 17 13:22:53 sf-prod bash[12345]: }
LOG

set +e
INNIES_CAPTURED_RESPONSE_HTML="$CAPTURED_HTML_PATH" \
INNIES_CAPTURED_REQUEST_ID="req_issue80_captured" \
INNIES_REPLAY_OUT_DIR="$TMP_DIR/out" \
INNIES_DIRECT_REQUEST_ID="req_issue80_direct" \
ANTHROPIC_OAUTH_ACCESS_TOKEN="sk-ant-oat-direct-token" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" >"$STDOUT_PATH" 2>"$STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  echo 'expected non-anthropic captured lane to fail'
  exit 1
fi

grep -q 'error: captured Innies lane resolved to openai; expected anthropic' "$STDERR_PATH"
