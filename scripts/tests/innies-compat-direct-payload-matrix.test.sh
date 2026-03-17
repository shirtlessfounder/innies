#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-direct-payload-matrix.sh"
TMP_DIR="$(mktemp -d)"
PAYLOADS_DIR="$TMP_DIR/payloads"
PAYLOADS_TSV_PATH="$TMP_DIR/payloads.tsv"
HEADERS_TSV_PATH="$TMP_DIR/direct-headers.tsv"
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

mkdir -p "$PAYLOADS_DIR" "$REQUESTS_DIR"

cat >"$PAYLOADS_DIR/shape_good.json" <<'JSON'
{"model":"claude-opus-4-6","stream":true,"max_tokens":32,"messages":[{"role":"user","content":[{"type":"text","text":"direct-payload-success"}]}]}
JSON

cat >"$PAYLOADS_DIR/shape_bad.json" <<'JSON'
{"model":"claude-opus-4-6","stream":true,"max_tokens":32,"messages":[{"role":"user","content":[{"type":"text","text":"direct-payload-invalid-request"}]}]}
JSON

cat >"$PAYLOADS_TSV_PATH" <<TSV
shape_good	$PAYLOADS_DIR/shape_good.json
shape_bad	$PAYLOADS_DIR/shape_bad.json
TSV

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
    const bodyText = bodyBuffer.toString('utf8');

    writeFileSync(join(requestsDir, `${requestId}.json`), JSON.stringify({
      method: req.method,
      url: req.url,
      headers: req.headers,
      bodyText,
      bodyBytes: bodyBuffer.length
    }, null, 2));

    if (bodyText.includes('direct-payload-success')) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.setHeader('request-id', 'req_provider_good');
      res.end(JSON.stringify({
        id: 'msg_payload_ok',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn'
      }));
      return;
    }

    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.setHeader('request-id', 'req_provider_bad');
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Error'
      },
      request_id: 'req_provider_bad'
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
CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat-payload-live-token" \
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
INNIES_DIRECT_PAYLOAD_MATRIX_REQUEST_ID_PREFIX="req_issue80_payload_matrix" \
INNIES_DIRECT_PAYLOAD_MATRIX_OUT_DIR="$OUT_DIR" \
"$SCRIPT_PATH" "$PAYLOADS_TSV_PATH" "$HEADERS_TSV_PATH" >"$STDOUT_PATH" 2>"$STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  cat "$STDERR_PATH" >&2
  exit 1
fi

[[ -f "$OUT_DIR/summary.txt" ]]
[[ -f "$OUT_DIR/payloads/shape_good/meta.txt" ]]
[[ -f "$OUT_DIR/payloads/shape_good/request-headers.tsv" ]]
[[ -f "$OUT_DIR/payloads/shape_good/response-headers.txt" ]]
[[ -f "$OUT_DIR/payloads/shape_good/response-body.txt" ]]
[[ -f "$OUT_DIR/payloads/shape_bad/meta.txt" ]]
[[ -f "$OUT_DIR/payloads/shape_bad/request-headers.tsv" ]]
[[ -f "$OUT_DIR/payloads/shape_bad/response-headers.txt" ]]
[[ -f "$OUT_DIR/payloads/shape_bad/response-body.txt" ]]

grep -q 'payload=shape_good status=200 provider_request_id=req_provider_good request_id=req_issue80_payload_matrix_shape_good token_source=claude_code_oauth_token' "$OUT_DIR/summary.txt"
grep -q 'payload=shape_bad status=400 provider_request_id=req_provider_bad request_id=req_issue80_payload_matrix_shape_bad token_source=claude_code_oauth_token' "$OUT_DIR/summary.txt"
grep -q '^authorization\tBearer <redacted>$' "$OUT_DIR/payloads/shape_good/request-headers.tsv"
grep -q '^authorization\tBearer <redacted>$' "$OUT_DIR/payloads/shape_bad/request-headers.tsv"
grep -q '^request_id=req_issue80_payload_matrix_shape_good$' "$OUT_DIR/payloads/shape_good/meta.txt"
grep -q '^request_id=req_issue80_payload_matrix_shape_bad$' "$OUT_DIR/payloads/shape_bad/meta.txt"
grep -q '^token_source=claude_code_oauth_token$' "$OUT_DIR/payloads/shape_good/meta.txt"
grep -q '^outcome=request_succeeded$' "$OUT_DIR/payloads/shape_good/meta.txt"
grep -q '^outcome=reproduced_invalid_request_error$' "$OUT_DIR/payloads/shape_bad/meta.txt"
grep -q '^summary_file=' "$STDOUT_PATH"

node - "$REQUESTS_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const requestsDir = process.argv[2];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const good = readJson(path.join(requestsDir, 'req_issue80_payload_matrix_shape_good.json'));
const bad = readJson(path.join(requestsDir, 'req_issue80_payload_matrix_shape_bad.json'));

if (good.headers.authorization !== 'Bearer sk-ant-oat-payload-live-token') {
  throw new Error('good payload auth header mismatch');
}
if (bad.headers.authorization !== 'Bearer sk-ant-oat-payload-live-token') {
  throw new Error('bad payload auth header mismatch');
}
if (good.headers['anthropic-beta'] !== 'fine-grained-tool-streaming-2025-05-14') {
  throw new Error('good payload beta mismatch');
}
if (!good.bodyText.includes('direct-payload-success')) {
  throw new Error('good payload body mismatch');
}
if (!bad.bodyText.includes('direct-payload-invalid-request')) {
  throw new Error('bad payload body mismatch');
}
NODE

EMPTY_PAYLOADS_TSV_PATH="$TMP_DIR/empty-payloads.tsv"
printf '# no payloads yet\n' >"$EMPTY_PAYLOADS_TSV_PATH"

set +e
CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat-payload-live-token" \
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
"$SCRIPT_PATH" "$EMPTY_PAYLOADS_TSV_PATH" "$HEADERS_TSV_PATH" >"$STDOUT_PATH" 2>"$STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  echo 'expected empty payload matrix invocation to fail' >&2
  exit 1
fi

grep -q 'no payload entries found' "$STDERR_PATH"
