#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-header-matrix.sh"
TMP_DIR="$(mktemp -d)"
PAYLOAD_PATH="$TMP_DIR/payload.json"
REQUESTS_DIR="$TMP_DIR/requests"
OUT_DIR="$TMP_DIR/out"
STDOUT_PATH="$TMP_DIR/stdout.txt"
STDERR_PATH="$TMP_DIR/stderr.txt"
STDOUT_CLAUDE_ENV_PATH="$TMP_DIR/stdout-claude-env.txt"
STDERR_CLAUDE_ENV_PATH="$TMP_DIR/stderr-claude-env.txt"
OUT_DIR_CLAUDE_ENV="$TMP_DIR/out-claude-env"
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
import { join } from 'node:path';

const port = Number(process.env.PORT);
const requestsDir = process.env.REQUESTS_DIR;
mkdirSync(requestsDir, { recursive: true });

const expectedMergedBeta = 'fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14';
const expectedCallerBeta = 'fine-grained-tool-streaming-2025-05-14';

function responseFor(headers) {
  const beta = headers['anthropic-beta'] ?? '';
  const identity = headers['anthropic-dangerous-direct-browser-access'] === 'true'
    && headers['x-app'] === 'cli'
    && headers['user-agent'] === 'OpenClawGateway/1.0';

  if (beta === expectedMergedBeta && identity) {
    return { status: 200, requestId: 'req_upstream_matrix_current_main', body: { id: 'msg_current_main', type: 'message' } };
  }
  if (beta === expectedMergedBeta) {
    return {
      status: 400,
      requestId: 'req_upstream_matrix_no_identity',
      body: { type: 'error', error: { type: 'invalid_request_error', message: 'Error' } }
    };
  }
  if (beta === expectedCallerBeta && identity) {
    return { status: 200, requestId: 'req_upstream_matrix_caller_identity', body: { id: 'msg_caller_identity', type: 'message' } };
  }
  return {
    status: 400,
    requestId: 'req_upstream_matrix_caller_only',
    body: { type: 'error', error: { type: 'invalid_request_error', message: 'Error' } }
  };
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
      body: JSON.parse(body)
    }, null, 2));

    const result = responseFor(req.headers);
    res.statusCode = result.status;
    res.setHeader('content-type', 'application/json');
    res.setHeader('request-id', result.requestId);
    res.end(JSON.stringify({ ...result.body, request_id: result.requestId }));
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
ANTHROPIC_OAUTH_ACCESS_TOKEN="sk-ant-oat-matrix-token" \
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
INNIES_MATRIX_OUT_DIR="$OUT_DIR" \
INNIES_MATRIX_REQUEST_ID_PREFIX="req_issue80_matrix" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" >"$STDOUT_PATH" 2>"$STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  cat "$STDERR_PATH"
  exit 1
fi

for case_name in \
  current_main_first_pass \
  merged_beta_without_identity \
  caller_beta_only \
  caller_beta_with_identity
do
  [[ -f "$OUT_DIR/cases/$case_name/meta.txt" ]]
  [[ -f "$OUT_DIR/cases/$case_name/headers.txt" ]]
  [[ -f "$OUT_DIR/cases/$case_name/body.txt" ]]
done

grep -q 'case=current_main_first_pass status=200 provider_request_id=req_upstream_matrix_current_main' "$OUT_DIR/summary.txt"
grep -q 'case=merged_beta_without_identity status=400 provider_request_id=req_upstream_matrix_no_identity' "$OUT_DIR/summary.txt"
grep -q 'case=caller_beta_only status=400 provider_request_id=req_upstream_matrix_caller_only' "$OUT_DIR/summary.txt"
grep -q 'case=caller_beta_with_identity status=200 provider_request_id=req_upstream_matrix_caller_identity' "$OUT_DIR/summary.txt"

grep -q '"anthropic-dangerous-direct-browser-access": "true"' "$REQUESTS_DIR/req_issue80_matrix_current_main_first_pass.json"
grep -q '"x-app": "cli"' "$REQUESTS_DIR/req_issue80_matrix_current_main_first_pass.json"
grep -q '"user-agent": "OpenClawGateway/1.0"' "$REQUESTS_DIR/req_issue80_matrix_current_main_first_pass.json"
grep -q '"anthropic-beta": "fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14"' "$REQUESTS_DIR/req_issue80_matrix_current_main_first_pass.json"

if grep -q 'anthropic-dangerous-direct-browser-access' "$REQUESTS_DIR/req_issue80_matrix_merged_beta_without_identity.json"; then
  echo 'merged_beta_without_identity should not send identity headers'
  exit 1
fi

grep -q '"anthropic-beta": "fine-grained-tool-streaming-2025-05-14"' "$REQUESTS_DIR/req_issue80_matrix_caller_beta_only.json"

grep -q '"anthropic-dangerous-direct-browser-access": "true"' "$REQUESTS_DIR/req_issue80_matrix_caller_beta_with_identity.json"
grep -q '"anthropic-beta": "fine-grained-tool-streaming-2025-05-14"' "$REQUESTS_DIR/req_issue80_matrix_caller_beta_with_identity.json"

set +e
CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat-claude-env-token" \
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
INNIES_MATRIX_OUT_DIR="$OUT_DIR_CLAUDE_ENV" \
INNIES_MATRIX_REQUEST_ID_PREFIX="req_issue80_matrix_claude_env" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" >"$STDOUT_CLAUDE_ENV_PATH" 2>"$STDERR_CLAUDE_ENV_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  cat "$STDERR_CLAUDE_ENV_PATH"
  exit 1
fi

grep -q '"authorization": "Bearer sk-ant-oat-claude-env-token"' "$REQUESTS_DIR/req_issue80_matrix_claude_env_current_main_first_pass.json"
grep -q 'case=current_main_first_pass status=200 provider_request_id=req_upstream_matrix_current_main' "$OUT_DIR_CLAUDE_ENV/summary.txt"
