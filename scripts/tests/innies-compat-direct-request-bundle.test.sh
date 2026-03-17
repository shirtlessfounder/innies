#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-direct-request-bundle.sh"
TMP_DIR="$(mktemp -d)"
PAYLOAD_PATH="$TMP_DIR/payload.json"
CAPTURED_HTML_PATH="$TMP_DIR/response.html"
REQUESTS_DIR="$TMP_DIR/requests"
OUT_DIR="$TMP_DIR/out"
STDOUT_PATH="$TMP_DIR/stdout.txt"
STDERR_PATH="$TMP_DIR/stderr.txt"
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
{"model":"claude-opus-4-6","stream":true,"max_tokens":16,"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}],"thinking":{"type":"enabled","budget_tokens":1024}}
JSON

PAYLOAD_SHA="$(openssl dgst -sha256 -r "$PAYLOAD_PATH" | awk '{print $1}')"
PAYLOAD_BYTES="$(wc -c <"$PAYLOAD_PATH" | tr -d '[:space:]')"

cat >"$CAPTURED_HTML_PATH" <<LOG
Mar 17 17:27:57 sf-prod bash[12345]: [compat-upstream-request-json-chunk] {
Mar 17 17:27:57 sf-prod bash[12345]:   chunk_index: 0,
Mar 17 17:27:57 sf-prod bash[12345]:   chunk_count: 1,
Mar 17 17:27:57 sf-prod bash[12345]:   json: '{"attempt_no":1,"body_bytes":${PAYLOAD_BYTES},"body_sha256":"${PAYLOAD_SHA}","credential_id":"cred_issue80","headers":{"accept":"text/event-stream","anthropic-beta":"fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14","anthropic-dangerous-direct-browser-access":"true","anthropic-version":"2023-06-01","authorization":"Bearer <redacted:108>","content-type":"application/json","user-agent":"OpenClawGateway/1.0","x-app":"cli","x-request-id":"req_issue80_captured"},"provider":"anthropic","proxied_path":"/v1/messages","request_id":"req_issue80_captured","stream":true,"target_url":"https://api.anthropic.com/v1/messages"}'
Mar 17 17:27:57 sf-prod bash[12345]: }
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
    res.setHeader('request-id', 'req_upstream_issue80_direct');
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Error' },
      request_id: 'req_upstream_issue80_direct'
    }));
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`ready:${port}\n`);
});
NODE

PORT="$(node -e "const net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>{console.log(server.address().port);server.close();});")"
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
INNIES_CAPTURED_RESPONSE_HTML="$CAPTURED_HTML_PATH" \
INNIES_CAPTURED_REQUEST_ID="req_issue80_captured" \
INNIES_DIRECT_BUNDLE_OUT_DIR="$OUT_DIR" \
INNIES_DIRECT_REQUEST_ID="req_issue80_direct" \
ANTHROPIC_OAUTH_ACCESS_TOKEN="sk-ant-oat-direct-token" \
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" >"$STDOUT_PATH" 2>"$STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  cat "$STDERR_PATH" >&2
  exit 1
fi

[[ -f "$OUT_DIR/captured-upstream-request.json" ]]
[[ -f "$OUT_DIR/direct-request.json" ]]
[[ -f "$OUT_DIR/direct-response.json" ]]
[[ -f "$OUT_DIR/direct-headers.txt" ]]
[[ -f "$OUT_DIR/direct-body.txt" ]]
[[ -f "$OUT_DIR/meta.txt" ]]

node - "$OUT_DIR/captured-upstream-request.json" "$PAYLOAD_SHA" "$PAYLOAD_BYTES" <<'NODE'
const fs = require('node:fs');

const bundlePath = process.argv[2];
const expectedSha = process.argv[3];
const expectedBytes = Number(process.argv[4]);
const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));

if (bundle.request_id !== 'req_issue80_captured') throw new Error(`unexpected captured request_id: ${bundle.request_id}`);
if (bundle.provider !== 'anthropic') throw new Error(`unexpected provider: ${bundle.provider}`);
if (bundle.body_sha256 !== expectedSha) throw new Error(`unexpected captured body_sha256: ${bundle.body_sha256}`);
if (bundle.body_bytes !== expectedBytes) throw new Error(`unexpected captured body_bytes: ${bundle.body_bytes}`);
if (bundle.headers['user-agent'] !== 'OpenClawGateway/1.0') throw new Error(`unexpected captured user-agent: ${bundle.headers['user-agent']}`);
NODE

node - "$OUT_DIR/direct-request.json" "$PAYLOAD_SHA" "$PAYLOAD_BYTES" <<'NODE'
const fs = require('node:fs');

const bundlePath = process.argv[2];
const expectedSha = process.argv[3];
const expectedBytes = Number(process.argv[4]);
const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));

if (bundle.request_id !== 'req_issue80_direct') throw new Error(`unexpected direct request_id: ${bundle.request_id}`);
if (bundle.method !== 'POST') throw new Error(`unexpected method: ${bundle.method}`);
if (!bundle.target_url.startsWith('http://127.0.0.1:') || !bundle.target_url.endsWith('/v1/messages')) {
  throw new Error(`unexpected target_url: ${bundle.target_url}`);
}
if (bundle.body_sha256 !== expectedSha) throw new Error(`unexpected direct body_sha256: ${bundle.body_sha256}`);
if (bundle.body_bytes !== expectedBytes) throw new Error(`unexpected direct body_bytes: ${bundle.body_bytes}`);
if (bundle.headers.authorization !== 'Bearer <redacted>') throw new Error(`unexpected authorization: ${bundle.headers.authorization}`);
if (bundle.headers['x-request-id'] !== 'req_issue80_direct') throw new Error(`unexpected x-request-id: ${bundle.headers['x-request-id']}`);
if (bundle.headers['anthropic-beta'] !== 'fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14') {
  throw new Error(`unexpected anthropic-beta: ${bundle.headers['anthropic-beta']}`);
}
if (bundle.headers['user-agent'] !== 'OpenClawGateway/1.0') throw new Error(`unexpected direct user-agent: ${bundle.headers['user-agent']}`);
NODE

node - "$OUT_DIR/direct-response.json" <<'NODE'
const fs = require('node:fs');

const bundle = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (bundle.status !== 400) throw new Error(`unexpected status: ${bundle.status}`);
if (bundle.provider_request_id !== 'req_upstream_issue80_direct') {
  throw new Error(`unexpected provider_request_id: ${bundle.provider_request_id}`);
}
if (bundle.error_type !== 'invalid_request_error') throw new Error(`unexpected error_type: ${bundle.error_type}`);
NODE

grep -q 'direct_request_id=req_issue80_direct' "$OUT_DIR/meta.txt"
grep -q 'direct_status=400' "$OUT_DIR/meta.txt"
grep -q 'provider_request_id=req_upstream_issue80_direct' "$OUT_DIR/meta.txt"
grep -q 'direct_access_token_source=anthropic_oauth_access_token' "$OUT_DIR/meta.txt"
grep -q '"authorization": "Bearer sk-ant-oat-direct-token"' "$REQUESTS_DIR/req_issue80_direct.json"
grep -q '"x-request-id": "req_issue80_direct"' "$REQUESTS_DIR/req_issue80_direct.json"
