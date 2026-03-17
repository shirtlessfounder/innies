#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-direct-bundle-from-request.sh"
TMP_DIR="$(mktemp -d)"
PAYLOAD_PATH="$TMP_DIR/payload.json"
SOURCE_DIR="$TMP_DIR/direct-source"
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

mkdir -p "$SOURCE_DIR" "$REQUESTS_DIR"

cat >"$PAYLOAD_PATH" <<'JSON'
{"model":"claude-opus-4-6","stream":true,"max_tokens":32,"messages":[{"role":"user","content":[{"type":"text","text":"hello from wrapper test"}]}]}
JSON

cat >"$SOURCE_DIR/direct-request.json" <<'JSON'
{
  "request_id": "req_known_good_direct",
  "body_bytes": 393038,
  "body_sha256": "fe256e82a18beecd90f4b5d7d3ae788b42ff6b2cd2693b12d695fc415f1fc853",
  "target_url": "https://api.anthropic.com/v1/messages",
  "headers": {
    "accept": "text/event-stream",
    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
    "anthropic-version": "2023-06-01",
    "authorization": "Bearer <redacted>",
    "content-type": "application/json",
    "x-request-id": "req_known_good_direct",
    "user-agent": "OpenClawGateway/1.0",
    "x-app": "cli",
    "anthropic-dangerous-direct-browser-access": "true"
  }
}
JSON

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
    res.setHeader('request-id', 'req_direct_bundle_from_request_provider');
    res.end(JSON.stringify({
      id: 'msg_direct_bundle_from_request_ok',
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
CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat-wrapper-fallback" \
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
INNIES_DIRECT_REQUEST_ID="req_issue80_from_request" \
INNIES_DIRECT_BUNDLE_FROM_REQUEST_OUT_DIR="$OUT_DIR" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" "$SOURCE_DIR" >"$STDOUT_PATH" 2>"$STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  cat "$STDERR_PATH" >&2
  exit 1
fi

[[ -f "$OUT_DIR/direct-headers.tsv" ]]
[[ -f "$OUT_DIR/direct-headers.summary.txt" ]]
[[ -f "$OUT_DIR/direct-bundle/direct-request.json" ]]
[[ -f "$OUT_DIR/direct-bundle/summary.txt" ]]
[[ -f "$OUT_DIR/summary.txt" ]]

cat >"$TMP_DIR/expected-headers.tsv" <<'TSV'
accept	text/event-stream
anthropic-beta	fine-grained-tool-streaming-2025-05-14
anthropic-version	2023-06-01
content-type	application/json
x-request-id	req_known_good_direct
user-agent	OpenClawGateway/1.0
x-app	cli
anthropic-dangerous-direct-browser-access	true
TSV

diff -u "$TMP_DIR/expected-headers.tsv" "$OUT_DIR/direct-headers.tsv"

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

const wrapperSummary = readSummary(path.join(outDir, 'summary.txt'));
const headerSummary = readSummary(path.join(outDir, 'direct-headers.summary.txt'));
const bundleSummary = readSummary(path.join(outDir, 'direct-bundle', 'summary.txt'));
const directRequest = readJson(path.join(outDir, 'direct-bundle', 'direct-request.json'));
const capturedRequest = readJson(path.join(requestsDir, 'req_issue80_from_request.json'));
const payloadBytes = fs.statSync(payloadPath).size;

if (headerSummary.request_id !== 'req_known_good_direct') throw new Error('header summary request_id mismatch');
if (headerSummary.source_file !== path.join(outDir, '..', 'direct-source', 'direct-request.json')) throw new Error('header summary source path mismatch');
if (bundleSummary.request_id !== 'req_issue80_from_request') throw new Error('bundle summary request_id mismatch');
if (bundleSummary.direct_status !== '200') throw new Error('bundle summary status mismatch');
if (bundleSummary.provider_request_id !== 'req_direct_bundle_from_request_provider') throw new Error('bundle provider request id mismatch');
if (directRequest.headers.authorization !== 'Bearer <redacted>') throw new Error('saved direct request should redact auth');
if (capturedRequest.headers.authorization !== 'Bearer sk-ant-oat-wrapper-fallback') throw new Error('live request auth mismatch');
if (capturedRequest.headers['x-request-id'] !== 'req_issue80_from_request') throw new Error('live request id mismatch');
if (capturedRequest.headers['user-agent'] !== 'OpenClawGateway/1.0') throw new Error('user-agent mismatch');
if (capturedRequest.bodyBytes !== payloadBytes) throw new Error('live request payload bytes mismatch');
if (wrapperSummary.source_path !== path.join(outDir, '..', 'direct-source')) throw new Error('wrapper source path mismatch');
if (wrapperSummary.direct_headers_tsv !== path.join(outDir, 'direct-headers.tsv')) throw new Error('wrapper headers tsv mismatch');
if (wrapperSummary.direct_header_summary_file !== path.join(outDir, 'direct-headers.summary.txt')) throw new Error('wrapper header summary mismatch');
if (wrapperSummary.direct_bundle_dir !== path.join(outDir, 'direct-bundle')) throw new Error('wrapper bundle dir mismatch');
if (wrapperSummary.direct_bundle_summary_file !== path.join(outDir, 'direct-bundle', 'summary.txt')) throw new Error('wrapper bundle summary mismatch');
if (wrapperSummary.request_id !== 'req_issue80_from_request') throw new Error('wrapper request id mismatch');
if (wrapperSummary.body_bytes !== String(payloadBytes)) throw new Error('wrapper body bytes mismatch');
if (wrapperSummary.body_sha256 !== bundleSummary.body_sha256) throw new Error('wrapper body sha mismatch');
NODE

grep -q '^summary_file=' "$STDOUT_PATH"
