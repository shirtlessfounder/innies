#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-exact-case-token-lane-matrix.sh"
TMP_DIR="$(mktemp -d)"
PAYLOAD_PATH="$TMP_DIR/payload.json"
CASES_DIR="$TMP_DIR/cases"
TOKENS_TSV_PATH="$TMP_DIR/token-lanes.tsv"
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
{"model":"claude-opus-4-6","stream":true,"max_tokens":32,"messages":[{"role":"user","content":[{"type":"text","text":"hello from exact case token lane matrix"}]}]}
JSON

cat >"$CASES_DIR/compat-exact.tsv" <<'TSV'
accept	text/event-stream
anthropic-beta	fine-grained-tool-streaming-2025-05-14
anthropic-version	2023-06-01
x-request-id	req_should_be_replaced
TSV

cat >"$CASES_DIR/compat-with-all-direct-deltas.tsv" <<'TSV'
accept	text/event-stream
anthropic-beta	fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14
anthropic-dangerous-direct-browser-access	true
anthropic-version	2023-06-01
content-type	application/json
user-agent	OpenClawGateway/1.0
x-app	cli
x-request-id	req_should_be_replaced
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

    const authHeader = String(req.headers.authorization ?? '');
    const beta = String(req.headers['anthropic-beta'] ?? '');
    const identityPresent = req.headers['anthropic-dangerous-direct-browser-access'] === 'true'
      && req.headers['x-app'] === 'cli'
      && req.headers['user-agent'] === 'OpenClawGateway/1.0';

    if (authHeader.endsWith('alpha-live-token') && beta === mergedBeta && identityPresent) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.setHeader('request-id', 'req_provider_alpha_success');
      res.end(JSON.stringify({
        id: 'msg_case_lane_ok',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn'
      }));
      return;
    }

    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.setHeader('request-id', 'req_provider_case_lane_fail');
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Error' },
      request_id: 'req_provider_case_lane_fail'
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
INNIES_EXACT_CASE_TOKEN_LANE_MATRIX_OUT_DIR="$OUT_DIR" \
INNIES_EXACT_CASE_TOKEN_LANE_MATRIX_REQUEST_ID_PREFIX="req_issue80_case_lane" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" "$CASES_DIR" "$TOKENS_TSV_PATH" >"$STDOUT_PATH" 2>"$STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  cat "$STDERR_PATH" >&2
  exit 1
fi

[[ -f "$OUT_DIR/summary.txt" ]]
[[ -f "$OUT_DIR/lanes/lane_alpha/cases/compat-exact/meta.txt" ]]
[[ -f "$OUT_DIR/lanes/lane_alpha/cases/compat-exact/request-headers.tsv" ]]
[[ -f "$OUT_DIR/lanes/lane_alpha/cases/compat-exact/response-headers.txt" ]]
[[ -f "$OUT_DIR/lanes/lane_alpha/cases/compat-exact/response-body.txt" ]]
[[ -f "$OUT_DIR/lanes/lane_alpha/cases/compat-with-all-direct-deltas/meta.txt" ]]
[[ -f "$OUT_DIR/lanes/lane_beta/cases/compat-with-all-direct-deltas/meta.txt" ]]

grep -q '^body_bytes=' "$OUT_DIR/summary.txt"
grep -q '^body_sha256=' "$OUT_DIR/summary.txt"
grep -q '^case_count=2$' "$OUT_DIR/summary.txt"
grep -q '^lane_count=2$' "$OUT_DIR/summary.txt"
grep -q 'lane=lane_alpha case=compat-with-all-direct-deltas status=200 outcome=request_succeeded provider_request_id=req_provider_alpha_success request_id=req_issue80_case_lane_lane_alpha_compat-with-all-direct-deltas token_source=env:ANTHROPIC_TOKEN_ALPHA' "$OUT_DIR/summary.txt"
grep -q 'lane=lane_alpha case=compat-exact status=400 outcome=reproduced_invalid_request_error provider_request_id=req_provider_case_lane_fail request_id=req_issue80_case_lane_lane_alpha_compat-exact token_source=env:ANTHROPIC_TOKEN_ALPHA' "$OUT_DIR/summary.txt"
grep -q 'lane=lane_beta case=compat-with-all-direct-deltas status=400 outcome=reproduced_invalid_request_error provider_request_id=req_provider_case_lane_fail request_id=req_issue80_case_lane_lane_beta_compat-with-all-direct-deltas token_source=literal' "$OUT_DIR/summary.txt"

grep -q '^authorization\tBearer <redacted>$' "$OUT_DIR/lanes/lane_alpha/cases/compat-with-all-direct-deltas/request-headers.tsv"
grep -q '^request_id=req_issue80_case_lane_lane_alpha_compat-with-all-direct-deltas$' "$OUT_DIR/lanes/lane_alpha/cases/compat-with-all-direct-deltas/meta.txt"
grep -q '^token_source=literal$' "$OUT_DIR/lanes/lane_beta/cases/compat-with-all-direct-deltas/meta.txt"
grep -q '^summary_file=' "$STDOUT_PATH"

node - "$REQUESTS_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const requestsDir = process.argv[2];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const alphaSuccess = readJson(path.join(requestsDir, 'req_issue80_case_lane_lane_alpha_compat-with-all-direct-deltas.json'));
const alphaCompat = readJson(path.join(requestsDir, 'req_issue80_case_lane_lane_alpha_compat-exact.json'));
const betaSuccessCase = readJson(path.join(requestsDir, 'req_issue80_case_lane_lane_beta_compat-with-all-direct-deltas.json'));

if (alphaSuccess.headers.authorization !== 'Bearer sk-ant-oat-alpha-live-token') {
  throw new Error('alpha success auth header mismatch');
}
if (alphaSuccess.headers['anthropic-beta'] !== 'fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14') {
  throw new Error('alpha success beta mismatch');
}
if (alphaCompat.headers['anthropic-beta'] !== 'fine-grained-tool-streaming-2025-05-14') {
  throw new Error('alpha compat case beta mismatch');
}
if (betaSuccessCase.headers.authorization !== 'Bearer sk-ant-oat-beta-live-token') {
  throw new Error('beta auth header mismatch');
}
if (betaSuccessCase.headers['x-app'] !== 'cli') {
  throw new Error('beta case identity header mismatch');
}
NODE

MISSING_TOKENS_TSV_PATH="$TMP_DIR/missing-token-lanes.tsv"
cat >"$MISSING_TOKENS_TSV_PATH" <<'TSV'
lane_missing	env:ANTHROPIC_TOKEN_MISSING
TSV

set +e
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" "$CASES_DIR" "$MISSING_TOKENS_TSV_PATH" >"$STDOUT_PATH" 2>"$STDERR_PATH"
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  echo 'expected missing env token invocation to fail' >&2
  exit 1
fi

grep -q 'missing token env var' "$STDERR_PATH"
