#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-direct-token-lane-matrix.sh"
TMP_DIR="$(mktemp -d)"
PAYLOAD_PATH="$TMP_DIR/payload.json"
HEADERS_TSV_PATH="$TMP_DIR/direct-headers.tsv"
TOKENS_TSV_PATH="$TMP_DIR/direct-tokens.tsv"
REQUESTS_DIR="$TMP_DIR/requests"
OUT_DIR="$TMP_DIR/out"
STDOUT_PATH="$TMP_DIR/stdout.txt"
STDERR_PATH="$TMP_DIR/stderr.txt"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$REQUESTS_DIR"

cat >"$PAYLOAD_PATH" <<'JSON'
{"model":"claude-opus-4-6","stream":true,"max_tokens":32,"messages":[{"role":"user","content":[{"type":"text","text":"hello from token matrix test"}]}]}
JSON

cat >"$HEADERS_TSV_PATH" <<'TSV'
accept	text/event-stream
anthropic-beta	fine-grained-tool-streaming-2025-05-14
anthropic-dangerous-direct-browser-access	true
anthropic-version	2023-06-01
content-type	application/json
user-agent	OpenClawGateway/1.0
x-app	cli
x-request-id	req_original_should_be_replaced
TSV

cat >"$TOKENS_TSV_PATH" <<'TSV'
lane_alpha	env:ANTHROPIC_TOKEN_ALPHA
lane_beta	literal:sk-ant-oat-beta-live-token
TSV

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
    const bodyBuffer = Buffer.concat(chunks);
    const requestId = String(req.headers['x-request-id'] ?? `unknown-${Date.now()}`);
    writeFileSync(join(requestsDir, `${requestId}.json`), JSON.stringify({
      method: req.method,
      url: req.url,
      headers: req.headers,
      bodyText: bodyBuffer.toString('utf8'),
      bodyBytes: bodyBuffer.length
    }, null, 2));

    const authHeader = String(req.headers.authorization ?? '');
    if (authHeader.endsWith('alpha-live-token')) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.setHeader('request-id', 'req_provider_alpha');
      res.end(JSON.stringify({
        id: 'msg_alpha_ok',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn'
      }));
      return;
    }

    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.setHeader('request-id', 'req_provider_beta');
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Error'
      },
      request_id: 'req_provider_beta'
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
  echo 'server did not start' >&2
  cat "$TMP_DIR/server.log" >&2
  exit 1
fi

set +e
ANTHROPIC_TOKEN_ALPHA="sk-ant-oat-alpha-live-token" \
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
INNIES_DIRECT_TOKEN_MATRIX_REQUEST_ID_PREFIX="req_issue80_token_matrix" \
INNIES_DIRECT_TOKEN_MATRIX_OUT_DIR="$OUT_DIR" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" "$HEADERS_TSV_PATH" "$TOKENS_TSV_PATH" >"$STDOUT_PATH" 2>"$STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  cat "$STDERR_PATH" >&2
  exit 1
fi

[[ -f "$OUT_DIR/summary.txt" ]]
[[ -f "$OUT_DIR/lanes/lane_alpha/meta.txt" ]]
[[ -f "$OUT_DIR/lanes/lane_alpha/request-headers.tsv" ]]
[[ -f "$OUT_DIR/lanes/lane_alpha/response-headers.txt" ]]
[[ -f "$OUT_DIR/lanes/lane_alpha/response-body.txt" ]]
[[ -f "$OUT_DIR/lanes/lane_beta/meta.txt" ]]
[[ -f "$OUT_DIR/lanes/lane_beta/request-headers.tsv" ]]
[[ -f "$OUT_DIR/lanes/lane_beta/response-headers.txt" ]]
[[ -f "$OUT_DIR/lanes/lane_beta/response-body.txt" ]]

grep -q 'lane=lane_alpha status=200 provider_request_id=req_provider_alpha request_id=req_issue80_token_matrix_lane_alpha token_source=env:ANTHROPIC_TOKEN_ALPHA' "$OUT_DIR/summary.txt"
grep -q 'lane=lane_beta status=400 provider_request_id=req_provider_beta request_id=req_issue80_token_matrix_lane_beta token_source=literal' "$OUT_DIR/summary.txt"
grep -q '^authorization\tBearer <redacted>$' "$OUT_DIR/lanes/lane_alpha/request-headers.tsv"
grep -q '^authorization\tBearer <redacted>$' "$OUT_DIR/lanes/lane_beta/request-headers.tsv"
grep -q '^request_id=req_issue80_token_matrix_lane_alpha$' "$OUT_DIR/lanes/lane_alpha/meta.txt"
grep -q '^request_id=req_issue80_token_matrix_lane_beta$' "$OUT_DIR/lanes/lane_beta/meta.txt"
grep -q '^token_source=env:ANTHROPIC_TOKEN_ALPHA$' "$OUT_DIR/lanes/lane_alpha/meta.txt"
grep -q '^token_source=literal$' "$OUT_DIR/lanes/lane_beta/meta.txt"
grep -q '^summary_file=' "$STDOUT_PATH"

node - "$REQUESTS_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const requestsDir = process.argv[2];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const laneAlpha = readJson(path.join(requestsDir, 'req_issue80_token_matrix_lane_alpha.json'));
const laneBeta = readJson(path.join(requestsDir, 'req_issue80_token_matrix_lane_beta.json'));

if (laneAlpha.headers.authorization !== 'Bearer sk-ant-oat-alpha-live-token') {
  throw new Error('lane alpha auth header mismatch');
}
if (laneBeta.headers.authorization !== 'Bearer sk-ant-oat-beta-live-token') {
  throw new Error('lane beta auth header mismatch');
}
if (laneAlpha.headers['anthropic-beta'] !== 'fine-grained-tool-streaming-2025-05-14') {
  throw new Error('lane alpha beta mismatch');
}
if (laneBeta.headers['x-app'] !== 'cli') {
  throw new Error('lane beta x-app mismatch');
}
NODE

MISSING_TOKENS_TSV_PATH="$TMP_DIR/missing-env.tsv"
cat >"$MISSING_TOKENS_TSV_PATH" <<'TSV'
lane_missing	env:ANTHROPIC_TOKEN_MISSING
TSV

set +e
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" "$HEADERS_TSV_PATH" "$MISSING_TOKENS_TSV_PATH" >"$STDOUT_PATH" 2>"$STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  echo 'expected missing env token invocation to fail' >&2
  exit 1
fi

grep -q 'missing token env var' "$STDERR_PATH"
