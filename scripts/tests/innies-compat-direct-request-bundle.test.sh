#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-direct-request-bundle.sh"
TMP_DIR="$(mktemp -d)"
PAYLOAD_PATH="$TMP_DIR/payload.json"
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

mkdir -p "$REQUESTS_DIR"

cat >"$PAYLOAD_PATH" <<'JSON'
{"model":"claude-opus-4-6","stream":true,"max_tokens":32,"messages":[{"role":"user","content":[{"type":"text","text":"hello from direct bundle test"}]}]}
JSON

cat >"$HEADERS_TSV_PATH" <<'TSV'
accept	text/event-stream
anthropic-beta	fine-grained-tool-streaming-2025-05-14
anthropic-dangerous-direct-browser-access	true
anthropic-version	2023-06-01
content-type	application/json
user-agent	OpenClawGateway/1.0
x-app	cli
x-request-id	req_known_good_original
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

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('request-id', 'req_direct_bundle_provider');
    res.end(JSON.stringify({
      id: 'msg_direct_bundle_ok',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn'
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
CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat-claude-fallback" \
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
INNIES_DIRECT_REQUEST_ID="req_issue80_direct_bundle" \
INNIES_DIRECT_BUNDLE_OUT_DIR="$OUT_DIR" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" "$HEADERS_TSV_PATH" >"$STDOUT_PATH" 2>"$STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  cat "$STDERR_PATH" >&2
  exit 1
fi

[[ -f "$OUT_DIR/payload.json" ]]
[[ -f "$OUT_DIR/direct-request.json" ]]
[[ -f "$OUT_DIR/upstream-request.json" ]]
[[ -f "$OUT_DIR/direct-response.json" ]]
[[ -f "$OUT_DIR/upstream-response.json" ]]
[[ -f "$OUT_DIR/response-headers.txt" ]]
[[ -f "$OUT_DIR/response-body.txt" ]]
[[ -f "$OUT_DIR/summary.txt" ]]

node - "$OUT_DIR" "$REQUESTS_DIR" "$PAYLOAD_PATH" <<'NODE'
const fs = require('fs');
const path = require('path');
const outDir = process.argv[2];
const requestsDir = process.argv[3];
const payloadPath = process.argv[4];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readSummary(filePath) {
  const entries = {};
  for (const line of fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index === -1) continue;
    entries[line.slice(0, index)] = line.slice(index + 1);
  }
  return entries;
}

const payload = readJson(path.join(outDir, 'payload.json'));
const directRequest = readJson(path.join(outDir, 'direct-request.json'));
const upstreamRequest = readJson(path.join(outDir, 'upstream-request.json'));
const directResponse = readJson(path.join(outDir, 'direct-response.json'));
const upstreamResponse = readJson(path.join(outDir, 'upstream-response.json'));
const capturedRequest = readJson(path.join(requestsDir, 'req_issue80_direct_bundle.json'));
const payloadBytes = fs.statSync(payloadPath).size;
const summary = readSummary(path.join(outDir, 'summary.txt'));

if (payload.model !== 'claude-opus-4-6') throw new Error('payload.json missing model');
if (directRequest.request_id !== 'req_issue80_direct_bundle') throw new Error('direct request id mismatch');
if (upstreamRequest.request_id !== 'req_issue80_direct_bundle') throw new Error('upstream request id mismatch');
if (directRequest.body_bytes !== payloadBytes) throw new Error('body bytes mismatch');
if (summary.request_id !== 'req_issue80_direct_bundle') throw new Error('summary request id mismatch');
if (summary.direct_status !== '200') throw new Error('summary direct status mismatch');
if (summary.provider_request_id !== 'req_direct_bundle_provider') throw new Error('summary provider request id mismatch');
if (summary.direct_access_token_source !== 'claude_code_oauth_token') throw new Error('token source mismatch');
if (directRequest.headers.authorization !== 'Bearer <redacted>') throw new Error('request bundle should redact auth');
if (directRequest.headers['x-request-id'] !== 'req_issue80_direct_bundle') throw new Error('request bundle x-request-id mismatch');
if (directRequest.headers['anthropic-beta'] !== 'fine-grained-tool-streaming-2025-05-14') throw new Error('request bundle beta mismatch');
if (directRequest.headers['user-agent'] !== 'OpenClawGateway/1.0') throw new Error('request bundle user-agent mismatch');
if (directRequest.headers['x-app'] !== 'cli') throw new Error('request bundle x-app mismatch');
if (capturedRequest.headers.authorization !== 'Bearer sk-ant-oat-claude-fallback') throw new Error('upstream auth token mismatch');
if (capturedRequest.headers['x-request-id'] !== 'req_issue80_direct_bundle') throw new Error('upstream request id mismatch');
if (capturedRequest.headers['anthropic-beta'] !== 'fine-grained-tool-streaming-2025-05-14') throw new Error('upstream beta mismatch');
if (capturedRequest.headers['anthropic-dangerous-direct-browser-access'] !== 'true') throw new Error('identity header missing');
if (capturedRequest.bodyBytes !== payloadBytes) throw new Error('upstream payload bytes mismatch');
if (directResponse.status !== 200) throw new Error('direct response status mismatch');
if (upstreamResponse.status !== 200) throw new Error('upstream response status mismatch');
if (directResponse.provider_request_id !== 'req_direct_bundle_provider') throw new Error('direct response request id mismatch');
NODE

grep -q 'summary_file=' "$STDOUT_PATH"
