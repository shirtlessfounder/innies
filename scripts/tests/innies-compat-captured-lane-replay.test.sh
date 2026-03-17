#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-captured-lane-replay.sh"
TMP_DIR="$(mktemp -d)"
PAYLOAD_PATH="$TMP_DIR/payload.json"
CAPTURED_HTML_PATH="$TMP_DIR/response.html"
CAPTURED_OPENAI_HTML_PATH="$TMP_DIR/response-openai.html"
CAPTURED_MISMATCH_HTML_PATH="$TMP_DIR/response-mismatch.html"
REQUESTS_DIR="$TMP_DIR/requests"
OUT_DIR="$TMP_DIR/out"
GUARD_OUT_DIR="$TMP_DIR/out-openai"
MISMATCH_OUT_DIR="$TMP_DIR/out-mismatch"
STDOUT_PATH="$TMP_DIR/stdout.txt"
STDERR_PATH="$TMP_DIR/stderr.txt"
GUARD_STDOUT_PATH="$TMP_DIR/stdout-openai.txt"
GUARD_STDERR_PATH="$TMP_DIR/stderr-openai.txt"
MISMATCH_STDOUT_PATH="$TMP_DIR/stdout-mismatch.txt"
MISMATCH_STDERR_PATH="$TMP_DIR/stderr-mismatch.txt"
mkdir -p "$REQUESTS_DIR"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat >"$PAYLOAD_PATH" <<'JSON'
{"model":"claude-opus-4-6","stream":true,"max_tokens":16,"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}
JSON
PAYLOAD_BYTES="$(wc -c <"$PAYLOAD_PATH" | tr -d ' ')"

cat >"$CAPTURED_HTML_PATH" <<LOG
Mar 17 13:22:53 sf-prod bash[12345]: [compat-upstream-request-json-chunk] {
Mar 17 13:22:53 sf-prod bash[12345]:   chunk_index: 0,
Mar 17 13:22:53 sf-prod bash[12345]:   chunk_count: 1,
Mar 17 13:22:53 sf-prod bash[12345]:   json: '{"attempt_no":1,"body_bytes":${PAYLOAD_BYTES},"credential_id":"cred_issue80","headers":{"accept":"text/event-stream","anthropic-beta":"fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14","anthropic-dangerous-direct-browser-access":"true","anthropic-version":"2023-06-01","authorization":"Bearer <redacted:108>","content-type":"application/json","user-agent":"OpenClawGateway/1.0","x-app":"cli","x-request-id":"req_issue80_captured"},"provider":"anthropic","proxied_path":"/v1/messages","request_id":"req_issue80_captured","stream":true,"target_url":"https://api.anthropic.com/v1/messages"}'
Mar 17 13:22:53 sf-prod bash[12345]: }
LOG

cat >"$CAPTURED_OPENAI_HTML_PATH" <<LOG
Mar 17 13:22:53 sf-prod bash[12345]: [compat-upstream-request-json-chunk] {
Mar 17 13:22:53 sf-prod bash[12345]:   chunk_index: 0,
Mar 17 13:22:53 sf-prod bash[12345]:   chunk_count: 1,
Mar 17 13:22:53 sf-prod bash[12345]:   json: '{"attempt_no":1,"body_bytes":${PAYLOAD_BYTES},"credential_id":"cred_issue80","headers":{"accept":"text/event-stream","anthropic-beta":"fine-grained-tool-streaming-2025-05-14","content-type":"application/json","x-request-id":"req_issue80_openai"},"provider":"openai","proxied_path":"/v1/messages","request_id":"req_issue80_openai","stream":true,"target_url":"https://api.anthropic.com/v1/messages"}'
Mar 17 13:22:53 sf-prod bash[12345]: }
LOG

cat >"$CAPTURED_MISMATCH_HTML_PATH" <<LOG
Mar 17 13:22:53 sf-prod bash[12345]: [compat-upstream-request-json-chunk] {
Mar 17 13:22:53 sf-prod bash[12345]:   chunk_index: 0,
Mar 17 13:22:53 sf-prod bash[12345]:   chunk_count: 1,
Mar 17 13:22:53 sf-prod bash[12345]:   json: '{"attempt_no":1,"body_bytes":999999,"credential_id":"cred_issue80","headers":{"accept":"text/event-stream","anthropic-beta":"fine-grained-tool-streaming-2025-05-14","anthropic-version":"2023-06-01","content-type":"application/json","x-request-id":"req_issue80_mismatch"},"provider":"anthropic","proxied_path":"/v1/messages","request_id":"req_issue80_mismatch","stream":true,"target_url":"https://api.anthropic.com/v1/messages"}'
Mar 17 13:22:53 sf-prod bash[12345]: }
LOG

cat >"$TMP_DIR/mock-server.mjs" <<'NODE'
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.env.PORT);
const requestsDir = process.env.REQUESTS_DIR;
mkdirSync(requestsDir, { recursive: true });

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const requestId = req.headers['x-request-id'] || `unknown-${Date.now()}`;
    writeFileSync(join(requestsDir, `${requestId}.json`), JSON.stringify({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: JSON.parse(body)
    }, null, 2));

    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.setHeader('request-id', 'req_upstream_captured_lane');
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Error' },
      request_id: 'req_upstream_captured_lane'
    }));
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`ready:${port}\n`);
});
NODE

PORT="$(node -e "const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const {port}=s.address();console.log(port);s.close();});")"
PORT="$PORT" REQUESTS_DIR="$REQUESTS_DIR" node "$TMP_DIR/mock-server.mjs" >"$TMP_DIR/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 50); do
  if grep -q '^ready:' "$TMP_DIR/server.log" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

if ! grep -q '^ready:' "$TMP_DIR/server.log" 2>/dev/null; then
  echo 'server did not start'
  cat "$TMP_DIR/server.log"
  exit 1
fi

set +e
INNIES_CAPTURED_RESPONSE_HTML="$CAPTURED_HTML_PATH" \
INNIES_CAPTURED_REQUEST_ID="req_issue80_captured" \
INNIES_REPLAY_OUT_DIR="$OUT_DIR" \
INNIES_DIRECT_REQUEST_ID="req_issue80_direct" \
ANTHROPIC_OAUTH_ACCESS_TOKEN="sk-ant-oat-direct-token" \
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" >"$STDOUT_PATH" 2>"$STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  cat "$STDERR_PATH"
  exit 1
fi

[[ -f "$OUT_DIR/meta.txt" ]]
[[ -f "$OUT_DIR/captured-headers.tsv" ]]
[[ -f "$OUT_DIR/direct-headers.txt" ]]
[[ -f "$OUT_DIR/direct-body.txt" ]]

grep -q "payload_bytes=$PAYLOAD_BYTES" "$OUT_DIR/meta.txt"
grep -q "captured_body_bytes=$PAYLOAD_BYTES" "$OUT_DIR/meta.txt"
grep -q 'captured_request_id=req_issue80_captured' "$OUT_DIR/meta.txt"
grep -q 'captured_provider=anthropic' "$OUT_DIR/meta.txt"
grep -q 'direct_request_id=req_issue80_direct' "$OUT_DIR/meta.txt"
grep -q 'direct_status=400' "$OUT_DIR/meta.txt"
grep -q 'provider_request_id=req_upstream_captured_lane' "$OUT_DIR/meta.txt"
grep -q 'outcome=reproduced_invalid_request_error' "$OUT_DIR/meta.txt"
grep -q 'meta_file=' "$STDOUT_PATH"

grep -q '"authorization": "Bearer sk-ant-oat-direct-token"' "$REQUESTS_DIR/req_issue80_direct.json"
grep -q '"anthropic-dangerous-direct-browser-access": "true"' "$REQUESTS_DIR/req_issue80_direct.json"
grep -q '"x-app": "cli"' "$REQUESTS_DIR/req_issue80_direct.json"
grep -q '"user-agent": "OpenClawGateway/1.0"' "$REQUESTS_DIR/req_issue80_direct.json"
grep -q '"anthropic-beta": "fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14"' "$REQUESTS_DIR/req_issue80_direct.json"
grep -q '"x-request-id": "req_issue80_direct"' "$REQUESTS_DIR/req_issue80_direct.json"

set +e
INNIES_CAPTURED_RESPONSE_HTML="$CAPTURED_OPENAI_HTML_PATH" \
INNIES_CAPTURED_REQUEST_ID="req_issue80_openai" \
INNIES_REPLAY_OUT_DIR="$GUARD_OUT_DIR" \
INNIES_DIRECT_REQUEST_ID="req_issue80_guard" \
ANTHROPIC_OAUTH_ACCESS_TOKEN="sk-ant-oat-direct-token" \
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" >"$GUARD_STDOUT_PATH" 2>"$GUARD_STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  echo 'expected non-anthropic provider guard to fail'
  exit 1
fi

grep -q 'error: captured Innies lane resolved to openai; expected anthropic' "$GUARD_STDERR_PATH"

set +e
INNIES_CAPTURED_RESPONSE_HTML="$CAPTURED_MISMATCH_HTML_PATH" \
INNIES_CAPTURED_REQUEST_ID="req_issue80_mismatch" \
INNIES_REPLAY_OUT_DIR="$MISMATCH_OUT_DIR" \
INNIES_DIRECT_REQUEST_ID="req_issue80_mismatch" \
ANTHROPIC_OAUTH_ACCESS_TOKEN="sk-ant-oat-direct-token" \
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" >"$MISMATCH_STDOUT_PATH" 2>"$MISMATCH_STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  echo 'expected payload byte mismatch guard to fail'
  exit 1
fi

grep -q "error: payload bytes ($PAYLOAD_BYTES) do not match captured body bytes (999999)" "$MISMATCH_STDERR_PATH"
