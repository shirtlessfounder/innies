#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-replay.sh"
TMP_DIR="$(mktemp -d)"
SERVER_LOG="$TMP_DIR/server.log"
REQUEST_HEADERS="$TMP_DIR/request-headers.json"
REQUEST_BODY="$TMP_DIR/request-body.json"
PAYLOAD_PATH="$TMP_DIR/payload.json"
OUTPUT_PATH="$TMP_DIR/output.txt"

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

cat >"$TMP_DIR/server.mjs" <<'NODE'
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const port = Number(process.env.PORT);
const headersPath = process.env.REQUEST_HEADERS_PATH;
const bodyPath = process.env.REQUEST_BODY_PATH;

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    writeFileSync(headersPath, JSON.stringify({
      method: req.method,
      url: req.url,
      headers: req.headers
    }, null, 2));
    writeFileSync(bodyPath, Buffer.concat(chunks).toString('utf8'));
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-request-id', 'req_test_replay');
    res.setHeader('x-innies-token-credential-id', 'cred_test_replay');
    res.setHeader('x-innies-attempt-no', '1');
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Error' },
      request_id: 'req_upstream_test'
    }));
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`ready:${port}\n`);
});
NODE

PORT="$(node -e "const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const {port}=s.address();console.log(port);s.close();});")"
REQUEST_HEADERS_PATH="$REQUEST_HEADERS" REQUEST_BODY_PATH="$REQUEST_BODY" PORT="$PORT" node "$TMP_DIR/server.mjs" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 50); do
  if grep -q '^ready:' "$SERVER_LOG" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

if ! grep -q '^ready:' "$SERVER_LOG" 2>/dev/null; then
  echo "server did not start"
  cat "$SERVER_LOG"
  exit 1
fi

set +e
INNIES_BASE_URL="http://127.0.0.1:$PORT" \
INNIES_BUYER_API_KEY="buyer_test_token" \
INNIES_REQUEST_ID="req_test_replay" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" >"$OUTPUT_PATH" 2>&1
SCRIPT_EXIT=$?
set -e

if [[ "$SCRIPT_EXIT" -ne 1 ]]; then
  echo "expected replay helper to exit 1 on 400, got $SCRIPT_EXIT"
  cat "$OUTPUT_PATH"
  exit 1
fi

grep -q 'status=400' "$OUTPUT_PATH"
grep -q 'request_id=req_test_replay' "$OUTPUT_PATH"
grep -q 'token_credential_id=cred_test_replay' "$OUTPUT_PATH"
grep -q 'attempt_no=1' "$OUTPUT_PATH"
grep -q 'upstream_request_id=req_upstream_test' "$OUTPUT_PATH"
grep -q 'outcome=reproduced_invalid_request_error' "$OUTPUT_PATH"

grep -q '"url": "/v1/messages"' "$REQUEST_HEADERS"
grep -q '"authorization": "Bearer buyer_test_token"' "$REQUEST_HEADERS"
grep -q '"anthropic-beta": "fine-grained-tool-streaming-2025-05-14"' "$REQUEST_HEADERS"
grep -q '"anthropic-version": "2023-06-01"' "$REQUEST_HEADERS"
grep -q '"x-request-id": "req_test_replay"' "$REQUEST_HEADERS"

cmp -s "$PAYLOAD_PATH" "$REQUEST_BODY"
