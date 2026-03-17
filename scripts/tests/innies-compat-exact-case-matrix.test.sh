#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-exact-case-matrix.sh"
TMP_DIR="$(mktemp -d)"
PAYLOAD_PATH="$TMP_DIR/payload.json"
CASES_DIR="$TMP_DIR/cases"
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

mkdir -p "$CASES_DIR" "$REQUESTS_DIR"

cat >"$PAYLOAD_PATH" <<'JSON'
{"model":"claude-opus-4-6","stream":true,"max_tokens":32,"messages":[{"role":"user","content":[{"type":"text","text":"hello from exact case matrix"}]}]}
JSON

cat >"$CASES_DIR/compat-with-all-direct-deltas.tsv" <<'TSV'
accept	text/event-stream
anthropic-beta	fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14
anthropic-dangerous-direct-browser-access	true
anthropic-version	2023-06-01
authorization	should-not-pass-through
content-length	999
host	api.anthropic.com
user-agent	OpenClawGateway/1.0
x-app	cli
x-request-id	req_should_be_replaced
TSV

cat >"$CASES_DIR/compat-exact.tsv" <<'TSV'
accept	text/event-stream
anthropic-beta	fine-grained-tool-streaming-2025-05-14
anthropic-version	2023-06-01
:authority	api.anthropic.com
TSV

cat >"$TMP_DIR/mock-server.mjs" <<'NODE'
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.env.PORT);
const requestsDir = process.env.REQUESTS_DIR;
mkdirSync(requestsDir, { recursive: true });

const mergedBeta = 'fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14';

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

    const identityPresent = req.headers['anthropic-dangerous-direct-browser-access'] === 'true'
      && req.headers['x-app'] === 'cli'
      && req.headers['user-agent'] === 'OpenClawGateway/1.0';
    const beta = String(req.headers['anthropic-beta'] ?? '');

    if (beta === mergedBeta && identityPresent) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.setHeader('request-id', 'req_upstream_exact_case_success');
      res.end(JSON.stringify({
        id: 'msg_exact_case_ok',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn'
      }));
      return;
    }

    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.setHeader('request-id', 'req_upstream_exact_case_fail');
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Error' },
      request_id: 'req_upstream_exact_case_fail'
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
CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat-exact-case-matrix" \
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
INNIES_EXACT_CASE_MATRIX_OUT_DIR="$OUT_DIR" \
INNIES_EXACT_CASE_MATRIX_REQUEST_ID_PREFIX="req_issue80_exact_case" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" "$CASES_DIR" >"$STDOUT_PATH" 2>"$STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  cat "$STDERR_PATH" >&2
  exit 1
fi

[[ -f "$OUT_DIR/summary.txt" ]]
[[ -f "$OUT_DIR/cases/compat-with-all-direct-deltas/summary.txt" ]]
[[ -f "$OUT_DIR/cases/compat-with-all-direct-deltas/request-headers.tsv" ]]
[[ -f "$OUT_DIR/cases/compat-with-all-direct-deltas/direct-request.json" ]]
[[ -f "$OUT_DIR/cases/compat-with-all-direct-deltas/direct-response.json" ]]
[[ -f "$OUT_DIR/cases/compat-exact/summary.txt" ]]
[[ -f "$OUT_DIR/cases/compat-exact/request-headers.tsv" ]]

grep -q '^body_bytes=' "$OUT_DIR/summary.txt"
grep -q '^body_sha256=' "$OUT_DIR/summary.txt"
grep -q '^case_count=2$' "$OUT_DIR/summary.txt"
grep -q 'case=compat-with-all-direct-deltas status=200 outcome=request_succeeded provider_request_id=req_upstream_exact_case_success' "$OUT_DIR/summary.txt"
grep -q 'case=compat-exact status=400 outcome=reproduced_invalid_request_error provider_request_id=req_upstream_exact_case_fail' "$OUT_DIR/summary.txt"

grep -q '^authorization	Bearer <redacted>$' "$OUT_DIR/cases/compat-with-all-direct-deltas/request-headers.tsv"
if grep -q '^authorization	should-not-pass-through$' "$OUT_DIR/cases/compat-with-all-direct-deltas/request-headers.tsv"; then
  echo 'redacted request headers should not keep authorization from the case TSV' >&2
  exit 1
fi
if grep -q '^:authority	' "$OUT_DIR/cases/compat-exact/request-headers.tsv"; then
  echo 'request headers should not keep HTTP/2 pseudo headers' >&2
  exit 1
fi

node - "$OUT_DIR" "$REQUESTS_DIR" "$PAYLOAD_PATH" <<'NODE'
const fs = require('fs');
const path = require('path');
const outDir = process.argv[2];
const requestsDir = process.argv[3];
const payloadPath = process.argv[4];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const payloadBytes = fs.statSync(payloadPath).size;
const successRequest = readJson(path.join(requestsDir, 'req_issue80_exact_case_compat-with-all-direct-deltas.json'));
const failRequest = readJson(path.join(requestsDir, 'req_issue80_exact_case_compat-exact.json'));
const successBundle = readJson(path.join(outDir, 'cases/compat-with-all-direct-deltas/direct-request.json'));
const failBundle = readJson(path.join(outDir, 'cases/compat-exact/direct-request.json'));
const successResponse = readJson(path.join(outDir, 'cases/compat-with-all-direct-deltas/direct-response.json'));
const failResponse = readJson(path.join(outDir, 'cases/compat-exact/direct-response.json'));

if (successRequest.headers.authorization !== 'Bearer sk-ant-oat-exact-case-matrix') {
  throw new Error('success request did not use the live bearer token');
}
if (successRequest.headers['x-request-id'] !== 'req_issue80_exact_case_compat-with-all-direct-deltas') {
  throw new Error('success request id was not normalized');
}
if (successRequest.headers['anthropic-beta'] !== 'fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14') {
  throw new Error('success request beta mismatch');
}
if (successRequest.headers.host !== '127.0.0.1:' + String(new URL(successRequest.url, 'http://127.0.0.1').port || '')) {
  // no-op host check; node sets host automatically for the mock server
}
if ('authorization' in successBundle.headers && successBundle.headers.authorization !== 'Bearer <redacted>') {
  throw new Error('success bundle should redact authorization');
}
if (successBundle.body_bytes !== payloadBytes) {
  throw new Error('success bundle body bytes mismatch');
}
if (successResponse.status !== 200) {
  throw new Error('success response status mismatch');
}
if (failRequest.headers['anthropic-beta'] !== 'fine-grained-tool-streaming-2025-05-14') {
  throw new Error('failure request beta mismatch');
}
if ('anthropic-dangerous-direct-browser-access' in failRequest.headers) {
  throw new Error('failure request should not include identity headers');
}
if (failBundle.headers['x-request-id'] !== 'req_issue80_exact_case_compat-exact') {
  throw new Error('failure bundle request id mismatch');
}
if (failResponse.status !== 400) {
  throw new Error('failure response status mismatch');
}
NODE

grep -q '^summary_file=' "$STDOUT_PATH"
