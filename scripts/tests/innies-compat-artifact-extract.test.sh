#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-artifact-extract.sh"
TMP_DIR="$(mktemp -d)"
FULL_ARTIFACT_PATH="$TMP_DIR/full-response.html"
NO_PAYLOAD_ARTIFACT_PATH="$TMP_DIR/no-payload-response.html"
OUT_DIR="$TMP_DIR/out"
OUT_DIR_NO_PAYLOAD="$TMP_DIR/out-no-payload"
STDOUT_PATH="$TMP_DIR/stdout.txt"
STDERR_PATH="$TMP_DIR/stderr.txt"
STDOUT_NO_PAYLOAD_PATH="$TMP_DIR/stdout-no-payload.txt"
STDERR_NO_PAYLOAD_PATH="$TMP_DIR/stderr-no-payload.txt"
STDOUT_MISSING_PATH="$TMP_DIR/stdout-missing.txt"
STDERR_MISSING_PATH="$TMP_DIR/stderr-missing.txt"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat >"$FULL_ARTIFACT_PATH" <<'LOG'
Mar 17 11:10:39 sf-prod bash[263845]: anthropicBeta: 'fine-grained-tool-streaming-2025-05-14'
Mar 17 11:10:39 sf-prod bash[263845]: anthropicVersion: '2023-06-01'
Mar 17 11:10:39 sf-prod bash[263845]: requestIdHeader: 'req_issue80_full'
Mar 17 11:10:39 sf-prod bash[263845]: [/v1/messages] request-payload-json-chunk {
Mar 17 11:10:39 sf-prod bash[263845]:   chunk_index: 0,
Mar 17 11:10:39 sf-prod bash[263845]:   chunk_count: 1,
Mar 17 11:10:39 sf-prod bash[263845]:   json: '{"body":{"model":"claude-opus-4-6","stream":true,"max_tokens":16,"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}}'
Mar 17 11:10:39 sf-prod bash[263845]: }
Mar 17 11:10:39 sf-prod bash[263845]: [compat-upstream-request-json-chunk] {
Mar 17 11:10:39 sf-prod bash[263845]:   chunk_index: 0,
Mar 17 11:10:39 sf-prod bash[263845]:   chunk_count: 1,
Mar 17 11:10:39 sf-prod bash[263845]:   json: '{"attempt_no":1,"body_bytes":126,"body_sha256":"sha_issue80_full","credential_id":"cred_issue80_full","credential_label":"aelix","headers":{"accept":"text/event-stream","anthropic-beta":"fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14","anthropic-version":"2023-06-01","authorization":"Bearer <redacted:108>","content-type":"application/json","x-request-id":"req_issue80_full"},"method":"POST","model":"claude-opus-4-6","provider":"anthropic","proxied_path":"/v1/messages","request_id":"req_issue80_full","stream":true,"target_url":"https://api.anthropic.com/v1/messages"}'
Mar 17 11:10:39 sf-prod bash[263845]: }
Mar 17 11:10:39 sf-prod bash[263845]: [compat-upstream-response-json-chunk] {
Mar 17 11:10:39 sf-prod bash[263845]:   chunk_index: 0,
Mar 17 11:10:39 sf-prod bash[263845]:   chunk_count: 1,
Mar 17 11:10:39 sf-prod bash[263845]:   json: `{"attempt_no":1,"credential_id":"cred_issue80_full","credential_label":"aelix","parsed_body":{"error":{"message":"Error","type":"invalid_request_error"},"request_id":"req_upstream_issue80_full","type":"error"},"provider":"anthropic","proxied_path":"/v1/messages","request_id":"req_issue80_full","response_headers":{"content-type":"application/json","request-id":"req_upstream_issue80_full"},"stream":true,"target_url":"https://api.anthropic.com/v1/messages","upstream_content_type":"application/json","upstream_status":400}`
Mar 17 11:10:39 sf-prod bash[263845]: }
Mar 17 11:10:39 sf-prod bash[263845]: [compat-invalid-request-payload-json-chunk] {
Mar 17 11:10:39 sf-prod bash[263845]:   chunk_index: 0,
Mar 17 11:10:39 sf-prod bash[263845]:   chunk_count: 1,
Mar 17 11:10:39 sf-prod bash[263845]:   json: '{"model":"claude-opus-4-6","stream":true,"max_tokens":16,"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}'
Mar 17 11:10:39 sf-prod bash[263845]: }
LOG

cat >"$NO_PAYLOAD_ARTIFACT_PATH" <<'LOG'
Mar 17 13:22:53 sf-prod bash[269534]: [compat-upstream-request-json-chunk] {
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_index: 0,
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_count: 1,
Mar 17 13:22:53 sf-prod bash[269534]:   json: '{"attempt_no":1,"body_bytes":398262,"body_sha256":"1717a039bed013d162eb47daead7f7eea440bccc6fb2719b9233142976e9a093","credential_id":"8aa85176-43e1-47fb-b5dd-cc22dadd48ed","credential_label":"aelix","headers":{"accept":"text/event-stream","anthropic-beta":"fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14","anthropic-dangerous-direct-browser-access":"true","anthropic-version":"2023-06-01","authorization":"Bearer <redacted:108>","content-type":"application/json","user-agent":"OpenClawGateway/1.0","x-app":"cli","x-request-id":"req_issue80_no_payload"},"method":"POST","model":"claude-opus-4-6","provider":"anthropic","proxied_path":"/v1/messages","request_id":"req_issue80_no_payload","request_shape":{"message_count":436,"tool_count":21,"thinking_present":true},"stream":true,"target_url":"https://api.anthropic.com/v1/messages"}'
Mar 17 13:22:53 sf-prod bash[269534]: }
Mar 17 13:22:54 sf-prod bash[269534]: [compat-upstream-response-json-chunk] {
Mar 17 13:22:54 sf-prod bash[269534]:   chunk_index: 0,
Mar 17 13:22:54 sf-prod bash[269534]:   chunk_count: 1,
Mar 17 13:22:54 sf-prod bash[269534]:   json: `{"attempt_no":1,"credential_id":"8aa85176-43e1-47fb-b5dd-cc22dadd48ed","credential_label":"aelix","parsed_body":{"error":{"message":"Error","type":"invalid_request_error"},"request_id":"req_upstream_issue80_no_payload","type":"error"},"provider":"anthropic","proxied_path":"/v1/messages","request_id":"req_issue80_no_payload","response_headers":{"content-type":"application/json","request-id":"req_upstream_issue80_no_payload"},"stream":true,"target_url":"https://api.anthropic.com/v1/messages","upstream_content_type":"application/json","upstream_status":400}`
Mar 17 13:22:54 sf-prod bash[269534]: }
LOG

set +e
INNIES_EXTRACT_OUT_DIR="$OUT_DIR" \
"$SCRIPT_PATH" "$FULL_ARTIFACT_PATH" "req_issue80_full" >"$STDOUT_PATH" 2>"$STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  cat "$STDERR_PATH"
  exit 1
fi

[[ -f "$OUT_DIR/summary.txt" ]]
[[ -f "$OUT_DIR/ingress.json" ]]
[[ -f "$OUT_DIR/payload.json" ]]
[[ -f "$OUT_DIR/upstream-request.json" ]]
[[ -f "$OUT_DIR/upstream-response.json" ]]
[[ -f "$OUT_DIR/invalid-request-payload.json" ]]

grep -q '^request_id=req_issue80_full$' "$STDOUT_PATH"
grep -q '^attempt_no=1$' "$STDOUT_PATH"
grep -q '^payload_available=true$' "$STDOUT_PATH"
grep -q '^provider_request_id=req_upstream_issue80_full$' "$STDOUT_PATH"
grep -q '^payload_file='"$OUT_DIR"'/payload.json$' "$STDOUT_PATH"
grep -q '^summary_file='"$OUT_DIR"'/summary.txt$' "$STDOUT_PATH"

grep -q '"anthropicBeta": "fine-grained-tool-streaming-2025-05-14"' "$OUT_DIR/ingress.json"
grep -q '"model": "claude-opus-4-6"' "$OUT_DIR/payload.json"
grep -q '"body_sha256": "sha_issue80_full"' "$OUT_DIR/upstream-request.json"
grep -q '"request_id": "req_upstream_issue80_full"' "$OUT_DIR/upstream-response.json"
grep -q '"messages"' "$OUT_DIR/invalid-request-payload.json"
grep -q '^body_sha256=sha_issue80_full$' "$OUT_DIR/summary.txt"
grep -q '^payload_available=true$' "$OUT_DIR/summary.txt"

set +e
INNIES_EXTRACT_OUT_DIR="$OUT_DIR_NO_PAYLOAD" \
"$SCRIPT_PATH" "$NO_PAYLOAD_ARTIFACT_PATH" "req_issue80_no_payload" >"$STDOUT_NO_PAYLOAD_PATH" 2>"$STDERR_NO_PAYLOAD_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  cat "$STDERR_NO_PAYLOAD_PATH"
  exit 1
fi

[[ -f "$OUT_DIR_NO_PAYLOAD/summary.txt" ]]
[[ -f "$OUT_DIR_NO_PAYLOAD/ingress.json" ]]
[[ -f "$OUT_DIR_NO_PAYLOAD/upstream-request.json" ]]
[[ -f "$OUT_DIR_NO_PAYLOAD/upstream-response.json" ]]

if [[ -f "$OUT_DIR_NO_PAYLOAD/payload.json" ]]; then
  echo 'did not expect payload.json when ingress payload chunks are missing'
  exit 1
fi

grep -q '^request_id=req_issue80_no_payload$' "$STDOUT_NO_PAYLOAD_PATH"
grep -q '^payload_available=false$' "$STDOUT_NO_PAYLOAD_PATH"
grep -q '^provider_request_id=req_upstream_issue80_no_payload$' "$STDOUT_NO_PAYLOAD_PATH"
grep -q '^body_sha256=1717a039bed013d162eb47daead7f7eea440bccc6fb2719b9233142976e9a093$' "$OUT_DIR_NO_PAYLOAD/summary.txt"
grep -q '^payload_available=false$' "$OUT_DIR_NO_PAYLOAD/summary.txt"
grep -q '"message_count": 436' "$OUT_DIR_NO_PAYLOAD/upstream-request.json"
grep -q '"request_id": "req_upstream_issue80_no_payload"' "$OUT_DIR_NO_PAYLOAD/upstream-response.json"

set +e
"$SCRIPT_PATH" "$FULL_ARTIFACT_PATH" "req_missing_issue80" >"$STDOUT_MISSING_PATH" 2>"$STDERR_MISSING_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  echo 'expected missing request id extraction to fail'
  exit 1
fi

grep -q 'error: could not find first-pass compat upstream request for req_missing_issue80' "$STDERR_MISSING_PATH"
