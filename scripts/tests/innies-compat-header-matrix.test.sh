#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-header-matrix.sh"
TMP_DIR="$(mktemp -d)"
CAPTURED_HTML="$TMP_DIR/captured-response.html"
REQUESTS_JSON="$TMP_DIR/requests.json"
SERVER_LOG="$TMP_DIR/server.log"
SUMMARY_PATH="$TMP_DIR/matrix-out/summary.txt"
PAYLOAD_PATH="$TMP_DIR/matrix-out/payload.json"
OUTPUT_PATH="$TMP_DIR/output.txt"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat >"$TMP_DIR/build-fixture.mjs" <<'NODE'
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const htmlPath = process.argv[2];

function stableJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(',')}}`;
}

function emitChunks(label, value, chunkSize = 160) {
  const json = stableJson(value);
  const chunkCount = Math.max(1, Math.ceil(json.length / chunkSize));
  const lines = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    lines.push(`fixture]: ${label} {`);
    lines.push(`fixture]:   chunk_index: ${chunkIndex},`);
    lines.push(`fixture]:   chunk_count: ${chunkCount},`);
    lines.push(`fixture]:   json: ${JSON.stringify(json.slice(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize))}`);
    lines.push('fixture]: }');
  }
  return lines;
}

const requestId = 'req_issue80_matrix';
const payload = {
  max_tokens: 16384,
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'hello from issue 80 matrix' }]
    }
  ],
  model: 'claude-opus-4-6',
  stream: true,
  system: 'keep tools and streaming intact'
};
const payloadText = stableJson(payload);
const payloadSha = createHash('sha256').update(payloadText).digest('hex');

const requestPayloadLog = {
  method: 'POST',
  path: '/v1/messages',
  requestIdHeader: requestId,
  body: payload
};

const upstreamRequestLog = {
  request_id: requestId,
  attempt_no: 1,
  credential_id: 'cred_issue80_matrix',
  credential_label: 'aelix',
  provider: 'anthropic',
  model: 'claude-opus-4-6',
  proxied_path: '/v1/messages',
  target_url: 'https://api.anthropic.com/v1/messages',
  method: 'POST',
  stream: true,
  headers: {
    accept: 'text/event-stream',
    'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14',
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-version': '2023-06-01',
    authorization: 'Bearer <redacted:108>',
    'content-type': 'application/json',
    'user-agent': 'OpenClawGateway/1.0',
    'x-app': 'cli',
    'x-request-id': requestId
  },
  body_bytes: Buffer.byteLength(payloadText, 'utf8'),
  body_sha256: payloadSha
};

const upstreamResponseLog = {
  request_id: requestId,
  attempt_no: 1,
  credential_id: 'cred_issue80_matrix',
  credential_label: 'aelix',
  provider: 'anthropic',
  model: 'claude-opus-4-6',
  proxied_path: '/v1/messages',
  target_url: 'https://api.anthropic.com/v1/messages',
  upstream_status: 400,
  parsed_body: {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'Error'
    },
    request_id: 'req_upstream_captured'
  },
  response_headers: {
    'request-id': 'req_upstream_captured'
  }
};

const lines = [
  ...emitChunks('[/v1/messages] request-payload-json-chunk', requestPayloadLog),
  ...emitChunks('[compat-upstream-request-json-chunk]', upstreamRequestLog),
  ...emitChunks('[compat-upstream-response-json-chunk]', upstreamResponseLog)
];

writeFileSync(htmlPath, `${lines.join('\n')}\n`);
NODE

node "$TMP_DIR/build-fixture.mjs" "$CAPTURED_HTML"

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

printf '[]\n' >"$REQUESTS_JSON"
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
  echo "server did not start"
  cat "$SERVER_LOG"
  exit 1
fi

ANTHROPIC_DIRECT_BASE_URL="http://127.0.0.1:$PORT" \
ANTHROPIC_OAUTH_ACCESS_TOKEN="sk-ant-oat-test-token" \
INNIES_HEADER_MATRIX_OUT_DIR="$TMP_DIR/matrix-out" \
"$SCRIPT_PATH" "$CAPTURED_HTML" "req_issue80_matrix" >"$OUTPUT_PATH" 2>&1

grep -q 'payload_matches_captured_sha=true' "$OUTPUT_PATH"
grep -q 'case_count=5' "$OUTPUT_PATH"
grep -q 'case=captured-baseline status=400 provider_request_id=req_upstream_case_1' "$OUTPUT_PATH"
grep -q 'case=caller-beta-only status=400 provider_request_id=req_upstream_case_2' "$OUTPUT_PATH"
grep -q 'case=identity-headers-removed status=400 provider_request_id=req_upstream_case_3' "$OUTPUT_PATH"
grep -q 'case=caller-beta-only-no-identity-headers status=400 provider_request_id=req_upstream_case_4' "$OUTPUT_PATH"
grep -q 'case=no-request-id status=400 provider_request_id=req_upstream_case_5' "$OUTPUT_PATH"

test -f "$SUMMARY_PATH"
test -f "$PAYLOAD_PATH"

node - "$REQUESTS_JSON" "$PAYLOAD_PATH" <<'NODE'
const fs = require('fs');

const requests = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const payload = fs.readFileSync(process.argv[3], 'utf8');

if (requests.length !== 5) {
  console.error(`expected 5 requests, saw ${requests.length}`);
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
  if (entry.body !== payload) {
    console.error(`request ${entry.index} body mismatch`);
    process.exit(1);
  }
}

requireHeader(1, 'anthropic-beta', 'fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14');
requireHeader(1, 'anthropic-dangerous-direct-browser-access', 'true');
requireHeader(1, 'user-agent', 'OpenClawGateway/1.0');
requireHeader(1, 'x-app', 'cli');
requireHeader(1, 'x-request-id', 'req_issue80_matrix__captured-baseline');

requireHeader(2, 'anthropic-beta', 'fine-grained-tool-streaming-2025-05-14');
requireHeader(2, 'x-request-id', 'req_issue80_matrix__caller-beta-only');

requireMissingHeader(3, 'anthropic-dangerous-direct-browser-access');
requireMissingHeader(3, 'user-agent');
requireMissingHeader(3, 'x-app');
requireHeader(3, 'x-request-id', 'req_issue80_matrix__identity-headers-removed');

requireHeader(4, 'anthropic-beta', 'fine-grained-tool-streaming-2025-05-14');
requireMissingHeader(4, 'anthropic-dangerous-direct-browser-access');
requireMissingHeader(4, 'user-agent');
requireMissingHeader(4, 'x-app');
requireHeader(4, 'x-request-id', 'req_issue80_matrix__caller-beta-only-no-identity-headers');

requireMissingHeader(5, 'x-request-id');
NODE
