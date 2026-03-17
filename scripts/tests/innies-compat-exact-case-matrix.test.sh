#!/usr/bin/env bash
set -euo pipefail

TEST_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${TEST_SCRIPT_DIR}/../.." && pwd)"
SCRIPT_PATH="${ROOT_DIR}/scripts/innies-compat-exact-case-matrix.sh"
TMP_DIR="$(mktemp -d)"
SERVER_PID=''

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file_exists() {
  local path="$1"
  [[ -f "$path" ]] || fail "expected file to exist: $path"
}

assert_file_contains() {
  local path="$1"
  local pattern="$2"
  if ! grep -Fq "$pattern" "$path"; then
    echo "Expected pattern not found in $path: $pattern" >&2
    echo "--- file contents ---" >&2
    cat "$path" >&2
    echo "---------------------" >&2
    exit 1
  fi
}

assert_file_not_contains() {
  local path="$1"
  local pattern="$2"
  if grep -Fq "$pattern" "$path"; then
    echo "Unexpected pattern found in $path: $pattern" >&2
    echo "--- file contents ---" >&2
    cat "$path" >&2
    echo "---------------------" >&2
    exit 1
  fi
}

PAYLOAD_PATH="$TMP_DIR/payload.json"
CASES_DIR="$TMP_DIR/cases"
REQUESTS_JSON="$TMP_DIR/requests.json"
SERVER_LOG="$TMP_DIR/server.log"
OUT_DIR="$TMP_DIR/out"
EMPTY_CASES_DIR="$TMP_DIR/empty-cases"
mkdir -p "$CASES_DIR" "$EMPTY_CASES_DIR"

cat >"$PAYLOAD_PATH" <<'JSON'
{
  "model": "claude-opus-4-6",
  "stream": true,
  "max_tokens": 16384,
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "hello from issue 80 exact case matrix"
        }
      ]
    }
  ]
}
JSON

cat >"$CASES_DIR/compat-with-direct-beta.tsv" <<'EOF_CASE'
accept	text/event-stream
anthropic-beta	fine-grained-tool-streaming-2025-05-14
anthropic-version	2023-06-01
content-type	application/json
EOF_CASE

cat >"$CASES_DIR/direct-exact.tsv" <<'EOF_CASE'
accept	text/event-stream
anthropic-beta	fine-grained-tool-streaming-2025-05-14
anthropic-dangerous-direct-browser-access	true
anthropic-version	2023-06-01
content-type	application/json
user-agent	OpenClawGateway/1.0
x-app	cli
x-request-id	req_issue80_direct_exact
EOF_CASE

cat >"$CASES_DIR/shared.tsv" <<'EOF_CASE'
accept	text/event-stream
anthropic-version	2023-06-01
content-type	application/json
EOF_CASE

printf '[]\n' >"$REQUESTS_JSON"

cat >"$TMP_DIR/server.mjs" <<'NODE'
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

const port = Number(process.env.PORT);
const requestsPath = process.env.REQUESTS_PATH;
let requestCount = 0;

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    requestCount += 1;
    const existing = JSON.parse(readFileSync(requestsPath, 'utf8'));
    existing.push({
      index: requestCount,
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8')
    });
    writeFileSync(requestsPath, JSON.stringify(existing, null, 2));

    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.setHeader('request-id', `req_upstream_case_${requestCount}`);
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Error' },
      request_id: `req_upstream_case_${requestCount}`
    }));
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`ready:${port}\n`);
});
NODE

PORT="$(node -e "const net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const address=server.address();console.log(address.port);server.close();});")"
REQUESTS_PATH="$REQUESTS_JSON" PORT="$PORT" node "$TMP_DIR/server.mjs" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 50); do
  if grep -q '^ready:' "$SERVER_LOG" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

if ! grep -q '^ready:' "$SERVER_LOG" 2>/dev/null; then
  fail "server did not start"
fi

ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
ANTHROPIC_OAUTH_ACCESS_TOKEN="sk-ant-oat-test-token" \
INNIES_EXACT_CASE_MATRIX_OUT_DIR="$OUT_DIR" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" "$CASES_DIR" >"$TMP_DIR/output.txt" 2>"$TMP_DIR/error.txt"

assert_file_exists "$OUT_DIR/payload.json"
assert_file_exists "$OUT_DIR/summary.txt"
assert_file_exists "$OUT_DIR/compat-with-direct-beta/request.json"
assert_file_exists "$OUT_DIR/compat-with-direct-beta/response.json"
assert_file_exists "$OUT_DIR/direct-exact/request.json"
assert_file_exists "$OUT_DIR/direct-exact/response.json"
assert_file_exists "$OUT_DIR/shared/request.json"
assert_file_exists "$OUT_DIR/shared/response.json"

assert_file_contains "$OUT_DIR/summary.txt" "payload_path=$PAYLOAD_PATH"
assert_file_contains "$OUT_DIR/summary.txt" 'case_count=3'
assert_file_contains "$OUT_DIR/summary.txt" 'case_files=compat-with-direct-beta.tsv,direct-exact.tsv,shared.tsv'
assert_file_contains "$OUT_DIR/summary.txt" 'case=compat-with-direct-beta status=400 provider_request_id=req_upstream_case_1'
assert_file_contains "$OUT_DIR/summary.txt" 'case=direct-exact status=400 provider_request_id=req_upstream_case_2'
assert_file_contains "$OUT_DIR/summary.txt" 'case=shared status=400 provider_request_id=req_upstream_case_3'

assert_file_contains "$OUT_DIR/direct-exact/request.json" '"authorization": "Bearer <redacted>"'
assert_file_not_contains "$OUT_DIR/direct-exact/request.json" 'sk-ant-oat-test-token'
assert_file_contains "$OUT_DIR/direct-exact/request.json" '"x-request-id": "req_issue80_direct_exact"'
assert_file_not_contains "$OUT_DIR/shared/request.json" '"x-request-id"'

node - "$REQUESTS_JSON" "$PAYLOAD_PATH" <<'NODE'
const fs = require('fs');

const requests = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const payload = fs.readFileSync(process.argv[3], 'utf8');

if (requests.length !== 3) {
  console.error(`expected 3 requests, saw ${requests.length}`);
  process.exit(1);
}

const byIndex = new Map(requests.map((entry) => [entry.index, entry]));

function requireHeader(index, name, expected) {
  const actual = byIndex.get(index)?.headers?.[name];
  if (actual !== expected) {
    console.error(`request ${index} expected header ${name}=${expected}, got ${actual}`);
    process.exit(1);
  }
}

function requireMissingHeader(index, name) {
  if (Object.prototype.hasOwnProperty.call(byIndex.get(index)?.headers ?? {}, name)) {
    console.error(`request ${index} should not send header ${name}`);
    process.exit(1);
  }
}

for (const entry of requests) {
  if (entry.method !== 'POST') {
    console.error(`request ${entry.index} expected POST, got ${entry.method}`);
    process.exit(1);
  }
  if (entry.url !== '/v1/messages') {
    console.error(`request ${entry.index} expected /v1/messages, got ${entry.url}`);
    process.exit(1);
  }
  if (entry.body !== payload) {
    console.error(`request ${entry.index} body mismatch`);
    process.exit(1);
  }
  requireHeader(entry.index, 'authorization', 'Bearer sk-ant-oat-test-token');
}

requireHeader(1, 'anthropic-beta', 'fine-grained-tool-streaming-2025-05-14');
requireMissingHeader(1, 'x-request-id');

requireHeader(2, 'anthropic-dangerous-direct-browser-access', 'true');
requireHeader(2, 'user-agent', 'OpenClawGateway/1.0');
requireHeader(2, 'x-app', 'cli');
requireHeader(2, 'x-request-id', 'req_issue80_direct_exact');

requireMissingHeader(3, 'anthropic-beta');
requireMissingHeader(3, 'x-request-id');
NODE

set +e
ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
ANTHROPIC_OAUTH_ACCESS_TOKEN="sk-ant-oat-test-token" \
"$SCRIPT_PATH" "$PAYLOAD_PATH" "$EMPTY_CASES_DIR" >"$TMP_DIR/empty.stdout.txt" 2>"$TMP_DIR/empty.stderr.txt"
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  fail "expected empty cases invocation to fail"
fi

assert_file_contains "$TMP_DIR/empty.stderr.txt" 'no case TSV files found'

echo 'PASS'
