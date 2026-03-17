#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-lane-compare.sh"
TMP_DIR="$(mktemp -d)"
PAYLOAD_PATH="$TMP_DIR/payload.json"
INNIES_REQUEST_HEADERS="$TMP_DIR/innies-request-headers.json"
INNIES_REQUEST_BODY="$TMP_DIR/innies-request-body.json"
DIRECT_REQUEST_HEADERS="$TMP_DIR/direct-request-headers.json"
DIRECT_REQUEST_BODY="$TMP_DIR/direct-request-body.json"
OUTPUT_PATH="$TMP_DIR/output.txt"
OUTPUT_FROM_LOG_PATH="$TMP_DIR/output-from-log.txt"
INNIES_SERVER_LOG="$TMP_DIR/innies-server.log"
DIRECT_SERVER_LOG="$TMP_DIR/direct-server.log"
OUT_DIR="$TMP_DIR/out"
OUT_DIR_FROM_LOG="$TMP_DIR/out-from-log"
CAPTURED_RESPONSE_HTML="$TMP_DIR/response.html"

cleanup() {
  if [[ -n "${INNIES_SERVER_PID:-}" ]]; then
    kill "$INNIES_SERVER_PID" >/dev/null 2>&1 || true
    wait "$INNIES_SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "${DIRECT_SERVER_PID:-}" ]]; then
    kill "$DIRECT_SERVER_PID" >/dev/null 2>&1 || true
    wait "$DIRECT_SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat >"$PAYLOAD_PATH" <<'JSON'
{"model":"claude-opus-4-6","stream":true,"max_tokens":16,"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}
JSON

cat >"$TMP_DIR/mock-server.mjs" <<'NODE'
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const port = Number(process.env.PORT);
const mode = process.env.MODE;
const headersPath = process.env.HEADERS_PATH;
const bodyPath = process.env.BODY_PATH;

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    writeFileSync(headersPath, JSON.stringify({
      method: req.method,
      url: req.url,
      headers: req.headers
    }, null, 2));
    writeFileSync(bodyPath, Buffer.concat(chunks).toString('utf8'));

    if (mode === 'innies') {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-request-id', 'req_issue80_innies_test');
      res.setHeader('x-innies-token-credential-id', 'cred_issue80_test');
      res.setHeader('x-innies-attempt-no', '1');
      res.setHeader('x-innies-debug-upstream-target-url', 'https://api.anthropic.com/v1/messages');
      res.setHeader('x-innies-debug-upstream-proxied-path', '/v1/messages');
      res.setHeader('x-innies-debug-upstream-provider', 'anthropic');
      res.setHeader('x-innies-debug-upstream-stream', 'true');
      res.setHeader('x-innies-debug-upstream-token-kind', 'anthropic_oauth');
      res.setHeader('x-innies-debug-upstream-authorization', 'Bearer <redacted:23>');
      res.setHeader('x-innies-debug-upstream-anthropic-version', '2023-06-01');
      res.setHeader('x-innies-debug-upstream-anthropic-beta', 'fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20');
      res.setHeader('x-innies-debug-upstream-accept', 'text/event-stream');
      res.setHeader('x-innies-debug-upstream-request-id', 'req_issue80_innies_test');
      res.setHeader('x-innies-debug-upstream-header-names', 'accept,anthropic-beta,anthropic-version,authorization,content-type,x-request-id');
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Error' },
        request_id: 'req_upstream_innies_test'
      }));
      return;
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('request-id', 'req_upstream_direct_test');
    res.end(JSON.stringify({ id: 'msg_direct_ok', type: 'message' }));
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`ready:${port}\n`);
});
NODE

start_server() {
  local mode="$1"
  local port_var="$2"
  local log_path="$3"
  local headers_path="$4"
  local body_path="$5"
  local pid_var="$6"
  local port
  port="$(node -e "const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const {port}=s.address();console.log(port);s.close();});")"
  MODE="$mode" HEADERS_PATH="$headers_path" BODY_PATH="$body_path" PORT="$port" \
    node "$TMP_DIR/mock-server.mjs" >"$log_path" 2>&1 &
  local pid=$!
  for _ in $(seq 1 50); do
    if grep -q '^ready:' "$log_path" 2>/dev/null; then
      printf -v "$port_var" '%s' "$port"
      printf -v "$pid_var" '%s' "$pid"
      return
    fi
    sleep 0.1
  done
  echo "server did not start: $mode"
  cat "$log_path"
  exit 1
}

start_server innies INNIES_PORT "$INNIES_SERVER_LOG" "$INNIES_REQUEST_HEADERS" "$INNIES_REQUEST_BODY" INNIES_SERVER_PID
start_server direct DIRECT_PORT "$DIRECT_SERVER_LOG" "$DIRECT_REQUEST_HEADERS" "$DIRECT_REQUEST_BODY" DIRECT_SERVER_PID

INNIES_BASE_URL="http://127.0.0.1:$INNIES_PORT" \
INNIES_BUYER_API_KEY="buyer_test_token" \
INNIES_REQUEST_ID="req_issue80_innies_test" \
INNIES_LANE_OUT_DIR="$OUT_DIR" \
ANTHROPIC_OAUTH_ACCESS_TOKEN="sk-ant-oat-direct-token" \
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$DIRECT_PORT" \
ANTHROPIC_DIRECT_REQUEST_ID="req_issue80_direct_test" \
ANTHROPIC_DIRECT_USER_AGENT="OpenClawGateway/1.0" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" >"$OUTPUT_PATH"

grep -q 'innies_status=400' "$OUTPUT_PATH"
grep -q 'direct_status=200' "$OUTPUT_PATH"
grep -q 'direct_only_header_names=user-agent' "$OUTPUT_PATH"
grep -q 'comparison_file=' "$OUTPUT_PATH"
grep -q 'innies_forwarded_request_id=req_issue80_innies_test' "$OUTPUT_PATH"
grep -q 'innies_provider_request_id=req_upstream_innies_test' "$OUTPUT_PATH"
grep -q 'direct_provider_request_id=req_upstream_direct_test' "$OUTPUT_PATH"

grep -q '"x-innies-debug-upstream-lane": "1"' "$INNIES_REQUEST_HEADERS"
grep -q '"authorization": "Bearer buyer_test_token"' "$INNIES_REQUEST_HEADERS"
grep -q '"authorization": "Bearer sk-ant-oat-direct-token"' "$DIRECT_REQUEST_HEADERS"
grep -q '"user-agent": "OpenClawGateway/1.0"' "$DIRECT_REQUEST_HEADERS"

cmp -s "$PAYLOAD_PATH" "$INNIES_REQUEST_BODY"
cmp -s "$PAYLOAD_PATH" "$DIRECT_REQUEST_BODY"

grep -q '^direct_only_header_names=user-agent$' "$OUT_DIR/comparison.txt"
grep -q '^innies_only_header_names=$' "$OUT_DIR/comparison.txt"

cat >"$CAPTURED_RESPONSE_HTML" <<'LOG'
Mar 17 11:10:39 sf-prod bash[263845]: [compat-upstream-request-json-chunk] {
Mar 17 11:10:39 sf-prod bash[263845]:   chunk_index: 0,
Mar 17 11:10:39 sf-prod bash[263845]:   chunk_count: 1,
Mar 17 11:10:39 sf-prod bash[263845]:   json: '{"attempt_no":1,"credential_id":"cred_issue80_from_log","credential_label":"aelix","headers":{"accept":"text/event-stream","anthropic-beta":"fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20","anthropic-version":"2023-06-01","authorization":"Bearer <redacted:108>","content-type":"application/json","x-request-id":"req_issue80_from_log"},"method":"POST","model":"claude-opus-4-6","payload":{"model":"claude-opus-4-6","stream":true,"max_tokens":16,"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]},"provider":"anthropic","proxied_path":"/v1/messages","request_id":"req_issue80_from_log","stream":true,"target_url":"https://api.anthropic.com/v1/messages"}'
Mar 17 11:10:39 sf-prod bash[263845]: }
Mar 17 11:10:39 sf-prod bash[263845]: [compat-upstream-response-json-chunk] {
Mar 17 11:10:39 sf-prod bash[263845]:   chunk_index: 0,
Mar 17 11:10:39 sf-prod bash[263845]:   chunk_count: 1,
Mar 17 11:10:39 sf-prod bash[263845]:   json: '{"attempt_no":1,"credential_id":"cred_issue80_from_log","credential_label":"aelix","parsed_body":{"error":{"message":"Error","type":"invalid_request_error"},"request_id":"req_upstream_from_log","type":"error"},"provider":"anthropic","proxied_path":"/v1/messages","request_id":"req_issue80_from_log","response_headers":{"content-type":"application/json","request-id":"req_upstream_from_log"},"stream":true,"target_url":"https://api.anthropic.com/v1/messages","upstream_content_type":"application/json","upstream_status":400}'
Mar 17 11:10:39 sf-prod bash[263845]: }
LOG

INNIES_CAPTURED_RESPONSE_HTML="$CAPTURED_RESPONSE_HTML" \
INNIES_CAPTURED_REQUEST_ID="req_issue80_from_log" \
INNIES_LANE_OUT_DIR="$OUT_DIR_FROM_LOG" \
ANTHROPIC_OAUTH_ACCESS_TOKEN="sk-ant-oat-direct-token" \
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$DIRECT_PORT" \
ANTHROPIC_DIRECT_REQUEST_ID="req_issue80_direct_from_log" \
ANTHROPIC_DIRECT_USER_AGENT="OpenClawGateway/1.0" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" >"$OUTPUT_FROM_LOG_PATH"

grep -q 'innies_status=400' "$OUTPUT_FROM_LOG_PATH"
grep -q 'innies_request_id=req_issue80_from_log' "$OUTPUT_FROM_LOG_PATH"
grep -q 'innies_forwarded_request_id=req_issue80_from_log' "$OUTPUT_FROM_LOG_PATH"
grep -q 'innies_provider_request_id=req_upstream_from_log' "$OUTPUT_FROM_LOG_PATH"
grep -q 'innies_upstream_token_kind=anthropic_oauth' "$OUTPUT_FROM_LOG_PATH"
grep -q 'innies_upstream_header_names=accept,anthropic-beta,anthropic-version,authorization,content-type,x-request-id' "$OUTPUT_FROM_LOG_PATH"
grep -q 'direct_status=200' "$OUTPUT_FROM_LOG_PATH"
grep -q 'comparison_file=' "$OUTPUT_FROM_LOG_PATH"

grep -q '"authorization": "Bearer sk-ant-oat-direct-token"' "$DIRECT_REQUEST_HEADERS"
cmp -s "$PAYLOAD_PATH" "$DIRECT_REQUEST_BODY"

grep -q '^innies_upstream_token_kind=anthropic_oauth$' "$OUT_DIR_FROM_LOG/comparison.txt"
grep -q '^direct_only_header_names=user-agent$' "$OUT_DIR_FROM_LOG/comparison.txt"
