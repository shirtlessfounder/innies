#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-lane-compare.sh"
TMP_DIR="$(mktemp -d)"
PAYLOAD_PATH="$TMP_DIR/payload.json"
INNIES_HEADERS_PATH="$TMP_DIR/innies-headers.json"
DIRECT_HEADERS_PATH="$TMP_DIR/direct-headers.json"
INNIES_BODY_PATH="$TMP_DIR/innies-body.json"
DIRECT_BODY_PATH="$TMP_DIR/direct-body.json"
INNIES_LOG_PATH="$TMP_DIR/innies.log"
DIRECT_LOG_PATH="$TMP_DIR/direct.log"
STDOUT_PATH="$TMP_DIR/stdout.txt"
STDERR_PATH="$TMP_DIR/stderr.txt"
CAPTURED_HTML_PATH="$TMP_DIR/response.html"

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
const upstreamProvider = process.env.UPSTREAM_PROVIDER;
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
      res.setHeader('x-request-id', 'req_issue80_guard_innies');
      res.setHeader('x-innies-token-credential-id', 'cred_issue80_guard');
      res.setHeader('x-innies-attempt-no', '1');
      res.setHeader('x-innies-debug-upstream-target-url', upstreamProvider === 'anthropic'
        ? 'https://api.anthropic.com/v1/messages'
        : 'https://chatgpt.com/backend-api/codex/responses');
      res.setHeader('x-innies-debug-upstream-proxied-path', '/v1/messages');
      res.setHeader('x-innies-debug-upstream-provider', upstreamProvider);
      res.setHeader('x-innies-debug-upstream-stream', 'true');
      res.setHeader('x-innies-debug-upstream-token-kind', upstreamProvider === 'anthropic' ? 'anthropic_oauth' : 'openai_oauth');
      res.setHeader('x-innies-debug-upstream-authorization', 'Bearer <redacted:23>');
      res.setHeader('x-innies-debug-upstream-anthropic-version', '2023-06-01');
      res.setHeader('x-innies-debug-upstream-anthropic-beta', 'fine-grained-tool-streaming-2025-05-14');
      res.setHeader('x-innies-debug-upstream-accept', 'text/event-stream');
      res.setHeader('x-innies-debug-upstream-request-id', 'req_issue80_guard_innies');
      res.setHeader('x-innies-debug-upstream-header-names', 'accept,anthropic-beta,anthropic-version,authorization,content-type,x-request-id');
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Error' },
        request_id: upstreamProvider === 'anthropic'
          ? 'req_upstream_guard_anthropic'
          : 'req_upstream_guard_openai'
      }));
      return;
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('request-id', 'req_upstream_guard_direct');
    res.end(JSON.stringify({ id: 'msg_direct_ok', type: 'message' }));
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`ready:${port}\n`);
});
NODE

start_server() {
  local mode="$1"
  local provider="$2"
  local port_var="$3"
  local log_path="$4"
  local headers_path="$5"
  local body_path="$6"
  local pid_var="$7"
  local port
  port="$(node -e "const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const {port}=s.address();console.log(port);s.close();});")"
  MODE="$mode" UPSTREAM_PROVIDER="$provider" HEADERS_PATH="$headers_path" BODY_PATH="$body_path" PORT="$port" \
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

run_live_compare() {
  local upstream_provider="$1"
  : >"$STDOUT_PATH"
  : >"$STDERR_PATH"

  start_server innies "$upstream_provider" INNIES_PORT "$INNIES_LOG_PATH" "$INNIES_HEADERS_PATH" "$INNIES_BODY_PATH" INNIES_SERVER_PID
  start_server direct anthropic DIRECT_PORT "$DIRECT_LOG_PATH" "$DIRECT_HEADERS_PATH" "$DIRECT_BODY_PATH" DIRECT_SERVER_PID

  set +e
  INNIES_BASE_URL="http://127.0.0.1:$INNIES_PORT" \
  INNIES_BUYER_API_KEY="buyer_test_token" \
  INNIES_REQUEST_ID="req_issue80_guard_innies" \
  INNIES_LANE_OUT_DIR="$TMP_DIR/out-live-$upstream_provider" \
  ANTHROPIC_OAUTH_ACCESS_TOKEN="sk-ant-oat-direct-token" \
  ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$DIRECT_PORT" \
  ANTHROPIC_DIRECT_REQUEST_ID="req_issue80_guard_direct" \
  "$SCRIPT_PATH" "$PAYLOAD_PATH" >"$STDOUT_PATH" 2>"$STDERR_PATH"
  local status=$?
  set -e

  kill "$INNIES_SERVER_PID" >/dev/null 2>&1 || true
  wait "$INNIES_SERVER_PID" 2>/dev/null || true
  unset INNIES_SERVER_PID
  kill "$DIRECT_SERVER_PID" >/dev/null 2>&1 || true
  wait "$DIRECT_SERVER_PID" 2>/dev/null || true
  unset DIRECT_SERVER_PID

  return "$status"
}

if ! run_live_compare anthropic; then
  cat "$STDERR_PATH"
  exit 1
fi

grep -q '"x-innies-provider-pin": "true"' "$INNIES_HEADERS_PATH"
grep -q 'innies_upstream_provider=anthropic' "$STDOUT_PATH"

if run_live_compare openai; then
  echo 'expected openai Innies live lane to fail'
  exit 1
fi

grep -q 'error: live Innies lane resolved to openai; expected anthropic' "$STDERR_PATH"

cat >"$CAPTURED_HTML_PATH" <<'LOG'
Mar 17 11:10:39 sf-prod bash[263845]: [compat-upstream-request-json-chunk] {
Mar 17 11:10:39 sf-prod bash[263845]:   chunk_index: 0,
Mar 17 11:10:39 sf-prod bash[263845]:   chunk_count: 1,
Mar 17 11:10:39 sf-prod bash[263845]:   json: '{"attempt_no":1,"credential_id":"cred_issue80_from_log","headers":{"accept":"text/event-stream","anthropic-version":"2023-06-01","authorization":"Bearer <redacted:108>","content-type":"application/json","x-request-id":"req_issue80_from_log"},"provider":"openai","proxied_path":"/v1/messages","request_id":"req_issue80_from_log","stream":true,"target_url":"https://chatgpt.com/backend-api/codex/responses"}'
Mar 17 11:10:39 sf-prod bash[263845]: }
Mar 17 11:10:39 sf-prod bash[263845]: [compat-upstream-response-json-chunk] {
Mar 17 11:10:39 sf-prod bash[263845]:   chunk_index: 0,
Mar 17 11:10:39 sf-prod bash[263845]:   chunk_count: 1,
Mar 17 11:10:39 sf-prod bash[263845]:   json: '{"attempt_no":1,"credential_id":"cred_issue80_from_log","parsed_body":{"error":{"message":"Error","type":"invalid_request_error"},"request_id":"req_upstream_from_log","type":"error"},"provider":"openai","proxied_path":"/v1/messages","request_id":"req_issue80_from_log","response_headers":{"content-type":"application/json","request-id":"req_upstream_from_log"},"stream":true,"target_url":"https://chatgpt.com/backend-api/codex/responses","upstream_content_type":"application/json","upstream_status":400}'
Mar 17 11:10:39 sf-prod bash[263845]: }
LOG

start_server direct anthropic DIRECT_PORT "$DIRECT_LOG_PATH" "$DIRECT_HEADERS_PATH" "$DIRECT_BODY_PATH" DIRECT_SERVER_PID

set +e
INNIES_CAPTURED_RESPONSE_HTML="$CAPTURED_HTML_PATH" \
INNIES_CAPTURED_REQUEST_ID="req_issue80_from_log" \
INNIES_LANE_OUT_DIR="$TMP_DIR/out-captured-openai" \
ANTHROPIC_OAUTH_ACCESS_TOKEN="sk-ant-oat-direct-token" \
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$DIRECT_PORT" \
ANTHROPIC_DIRECT_REQUEST_ID="req_issue80_guard_direct" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" >"$STDOUT_PATH" 2>"$STDERR_PATH"
CAPTURED_STATUS=$?
set -e

kill "$DIRECT_SERVER_PID" >/dev/null 2>&1 || true
wait "$DIRECT_SERVER_PID" 2>/dev/null || true
unset DIRECT_SERVER_PID

if [[ "$CAPTURED_STATUS" -eq 0 ]]; then
  echo 'expected captured openai Innies lane to fail'
  exit 1
fi

grep -q 'error: captured Innies lane resolved to openai; expected anthropic' "$STDERR_PATH"
