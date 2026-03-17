#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-direct-bundle-capture.sh"
TMP_DIR="$(mktemp -d)"
PAYLOAD_PATH="$TMP_DIR/payload.json"
REQUESTS_DIR="$TMP_DIR/requests"
OUT_DIR="$TMP_DIR/out"
STDOUT_PATH="$TMP_DIR/stdout.txt"
STDERR_PATH="$TMP_DIR/stderr.txt"
OUT_DIR_NO_IDENTITY="$TMP_DIR/out-no-identity"
STDOUT_NO_IDENTITY="$TMP_DIR/stdout-no-identity.txt"
STDERR_NO_IDENTITY="$TMP_DIR/stderr-no-identity.txt"
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

cat >"$TMP_DIR/mock-server.mjs" <<'NODE'
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const port = Number(process.env.PORT);
const requestsDir = process.env.REQUESTS_DIR;
mkdirSync(requestsDir, { recursive: true });

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

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
      body: JSON.parse(body),
      bodyBytes: Buffer.byteLength(body),
      bodySha256: sha256(body)
    }, null, 2));

    const responseBody = {
      id: `msg_${requestId}`,
      type: 'message',
      request_id: `req_provider_${requestId}`
    };
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('request-id', responseBody.request_id);
    res.end(JSON.stringify(responseBody));
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
CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat-claude-token" \
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
INNIES_DIRECT_CAPTURE_OUT_DIR="$OUT_DIR" \
INNIES_DIRECT_REQUEST_ID="req_issue80_direct_capture" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" >"$STDOUT_PATH" 2>"$STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  cat "$STDERR_PATH"
  exit 1
fi

[[ -f "$OUT_DIR/payload.json" ]]
[[ -f "$OUT_DIR/upstream-request.json" ]]
[[ -f "$OUT_DIR/upstream-response.json" ]]
[[ -f "$OUT_DIR/response-headers.txt" ]]
[[ -f "$OUT_DIR/response-body.txt" ]]
[[ -f "$OUT_DIR/summary.txt" ]]

grep -q '^request_id=req_issue80_direct_capture$' "$OUT_DIR/summary.txt"
grep -q '^provider=anthropic$' "$OUT_DIR/summary.txt"
grep -q '^direct_access_token_source=claude_code_oauth_token$' "$OUT_DIR/summary.txt"
grep -q '^upstream_status=200$' "$OUT_DIR/summary.txt"
grep -q '^provider_request_id=req_provider_req_issue80_direct_capture$' "$OUT_DIR/summary.txt"
grep -q '^upstream_user_agent=OpenClawGateway/1.0$' "$OUT_DIR/summary.txt"
grep -q '^upstream_x_app=cli$' "$OUT_DIR/summary.txt"
grep -q '^upstream_anthropic_beta=fine-grained-tool-streaming-2025-05-14$' "$OUT_DIR/summary.txt"

grep -q '"authorization": "Bearer <redacted>"' "$OUT_DIR/upstream-request.json"
grep -q '"request_id": "req_issue80_direct_capture"' "$OUT_DIR/upstream-request.json"
grep -q '"request_id": "req_issue80_direct_capture"' "$OUT_DIR/upstream-response.json"
grep -q '"upstream_status": 200' "$OUT_DIR/upstream-response.json"
grep -q '"provider_request_id": "req_provider_req_issue80_direct_capture"' "$OUT_DIR/upstream-response.json"

grep -q '"authorization": "Bearer sk-ant-oat-claude-token"' "$REQUESTS_DIR/req_issue80_direct_capture.json"
grep -q '"anthropic-dangerous-direct-browser-access": "true"' "$REQUESTS_DIR/req_issue80_direct_capture.json"
grep -q '"x-app": "cli"' "$REQUESTS_DIR/req_issue80_direct_capture.json"
grep -q '"user-agent": "OpenClawGateway/1.0"' "$REQUESTS_DIR/req_issue80_direct_capture.json"
grep -q '"anthropic-beta": "fine-grained-tool-streaming-2025-05-14"' "$REQUESTS_DIR/req_issue80_direct_capture.json"

set +e
ANTHROPIC_OAUTH_ACCESS_TOKEN="sk-ant-oat-direct-token" \
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
INNIES_DIRECT_CAPTURE_OUT_DIR="$OUT_DIR_NO_IDENTITY" \
INNIES_DIRECT_REQUEST_ID="req_issue80_direct_capture_no_identity" \
INNIES_DIRECT_INCLUDE_IDENTITY_HEADERS="false" \
INNIES_DIRECT_ANTHROPIC_BETA="fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" >"$STDOUT_NO_IDENTITY" 2>"$STDERR_NO_IDENTITY"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  cat "$STDERR_NO_IDENTITY"
  exit 1
fi

grep -q '^direct_access_token_source=anthropic_oauth_access_token$' "$OUT_DIR_NO_IDENTITY/summary.txt"
grep -q '^upstream_anthropic_beta=fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20$' "$OUT_DIR_NO_IDENTITY/summary.txt"

if grep -q 'anthropic-dangerous-direct-browser-access' "$REQUESTS_DIR/req_issue80_direct_capture_no_identity.json"; then
  echo 'identity-disabled capture should not send anthropic-dangerous-direct-browser-access'
  exit 1
fi

if grep -q '"x-app"' "$REQUESTS_DIR/req_issue80_direct_capture_no_identity.json"; then
  echo 'identity-disabled capture should not send x-app'
  exit 1
fi

if grep -q '"user-agent"' "$REQUESTS_DIR/req_issue80_direct_capture_no_identity.json"; then
  echo 'identity-disabled capture should not send user-agent'
  exit 1
fi

grep -q '"anthropic-beta": "fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20"' "$REQUESTS_DIR/req_issue80_direct_capture_no_identity.json"

set +e
ANTHROPIC_OAUTH_ACCESS_TOKEN="sk-ant-oat-direct-token" \
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
INNIES_DIRECT_REQUEST_ID="req_issue80_direct_capture_guard" \
INNIES_DIRECT_EXPECTED_BODY_BYTES="999" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" >"$TMP_DIR/stdout-guard.txt" 2>"$TMP_DIR/stderr-guard.txt"
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  echo 'expected byte guard run to fail'
  exit 1
fi

grep -q 'error: payload bytes (' "$TMP_DIR/stderr-guard.txt"
