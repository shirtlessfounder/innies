#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="${SCRIPT_DIR}/${SCRIPT_PATH}"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

resolve_direct_base_url() {
  if [[ -n "${ANTHROPIC_DIRECT_BASE_URL:-}" ]]; then
    printf '%s' "${ANTHROPIC_DIRECT_BASE_URL%/}"
    return
  fi
  if [[ -n "${ANTHROPIC_BASE_URL:-}" ]]; then
    printf '%s' "${ANTHROPIC_BASE_URL%/}"
    return
  fi
  printf '%s' 'https://api.anthropic.com'
}

extract_header() {
  local name="$1"
  local file="$2"
  awk -F': ' -v header_name="$name" '
    BEGIN { IGNORECASE = 1 }
    tolower($1) == tolower(header_name) {
      gsub("\r", "", $2)
      print $2
    }
  ' "$file" | tail -1
}

extract_body_request_id() {
  local file="$1"
  sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p' "$file" | head -n 1
}

redact_bearer_value() {
  local token="$1"
  printf 'Bearer <redacted:%s>' "${#token}"
}

write_lines() {
  local file="$1"
  shift
  printf '%s\n' "$@" >"$file"
}

load_captured_request() {
  local captured_html="$1"
  local request_id="$2"
  local payload_path="$3"

  node - "$captured_html" "$request_id" "$payload_path" <<'NODE'
const { createHash } = require('node:crypto');
const fs = require('node:fs');

const capturedHtmlPath = process.argv[2];
const requestId = process.argv[3];
const payloadPath = process.argv[4];

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

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stripLogPrefix(line) {
  return line.replace(/^.*?\]:\s*/, '');
}

function parseJsLiteral(literal) {
  return Function('"use strict"; return (' + literal + ');')();
}

function parseSerializedValue(text) {
  try {
    return JSON.parse(text);
  } catch {}
  return parseJsLiteral(text);
}

function parseChunkSeries(lines, startIndex, label) {
  const parts = [];
  let expectedChunkCount = null;
  let index = startIndex;
  while (index < lines.length) {
    const header = stripLogPrefix(lines[index]);
    if (header !== `${label} {`) break;
    const chunkIndexLine = stripLogPrefix(lines[index + 1] ?? '');
    const chunkCountLine = stripLogPrefix(lines[index + 2] ?? '');
    const jsonLine = stripLogPrefix(lines[index + 3] ?? '');
    const closeLine = stripLogPrefix(lines[index + 4] ?? '');
    const chunkIndexMatch = chunkIndexLine.match(/^chunk_index:\s*(\d+),?$/);
    const chunkCountMatch = chunkCountLine.match(/^chunk_count:\s*(\d+),?$/);
    const jsonMatch = jsonLine.match(/^json:\s*(.+)$/);
    if (!chunkIndexMatch || !chunkCountMatch || !jsonMatch || closeLine !== '}') {
      throw new Error(`Malformed ${label} chunk near line ${index + 1}`);
    }
    const chunkIndex = Number(chunkIndexMatch[1]);
    const chunkCount = Number(chunkCountMatch[1]);
    if (expectedChunkCount === null) expectedChunkCount = chunkCount;
    if (expectedChunkCount !== chunkCount) {
      throw new Error(`Mismatched ${label} chunk_count near line ${index + 1}`);
    }
    if (chunkIndex !== parts.length) {
      throw new Error(`Out-of-order ${label} chunk_index near line ${index + 1}`);
    }
    parts.push(parseJsLiteral(jsonMatch[1]));
    index += 5;
    if (parts.length === expectedChunkCount) {
      return { text: parts.join(''), nextIndex: index - 1 };
    }
  }
  throw new Error(`Incomplete ${label} chunk series near line ${startIndex + 1}`);
}

function collectSeries(lines, label) {
  const values = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (stripLogPrefix(lines[index]) !== `${label} {`) continue;
    const { text, nextIndex } = parseChunkSeries(lines, index, label);
    values.push({ rawText: text, value: parseSerializedValue(text) });
    index = nextIndex;
  }
  return values;
}

function skipWhitespace(rawText, index) {
  let cursor = index;
  while (cursor < rawText.length && /\s/.test(rawText[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function consumeJsonString(rawText, startIndex) {
  let cursor = startIndex + 1;
  let escaped = false;
  while (cursor < rawText.length) {
    const char = rawText[cursor];
    if (escaped) {
      escaped = false;
    } else if (char === '\\\\') {
      escaped = true;
    } else if (char === '"') {
      return cursor + 1;
    }
    cursor += 1;
  }
  throw new Error('Unterminated JSON string while extracting raw payload');
}

function consumeJsonValue(rawText, startIndex) {
  let cursor = skipWhitespace(rawText, startIndex);
  const firstChar = rawText[cursor];
  if (firstChar === '"') {
    return consumeJsonString(rawText, cursor);
  }
  if (firstChar === '{' || firstChar === '[') {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; cursor < rawText.length; cursor += 1) {
      const char = rawText[cursor];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{' || char === '[') {
        depth += 1;
        continue;
      }
      if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) {
          return cursor + 1;
        }
      }
    }
    throw new Error('Unterminated JSON object/array while extracting raw payload');
  }
  while (cursor < rawText.length && !/[,\]}]/.test(rawText[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function extractTopLevelJsonValue(rawText, key) {
  let cursor = skipWhitespace(rawText, 0);
  if (rawText[cursor] !== '{') return null;
  cursor += 1;
  while (cursor < rawText.length) {
    cursor = skipWhitespace(rawText, cursor);
    if (rawText[cursor] === '}') return null;
    if (rawText[cursor] !== '"') {
      throw new Error(`Malformed JSON object while extracting ${key}`);
    }
    const keyEnd = consumeJsonString(rawText, cursor);
    const parsedKey = JSON.parse(rawText.slice(cursor, keyEnd));
    cursor = skipWhitespace(rawText, keyEnd);
    if (rawText[cursor] !== ':') {
      throw new Error(`Missing colon after key ${parsedKey}`);
    }
    cursor = skipWhitespace(rawText, cursor + 1);
    const valueStart = cursor;
    const valueEnd = consumeJsonValue(rawText, valueStart);
    if (parsedKey === key) {
      return rawText.slice(valueStart, valueEnd);
    }
    cursor = skipWhitespace(rawText, valueEnd);
    if (rawText[cursor] === ',') {
      cursor += 1;
      continue;
    }
    if (rawText[cursor] === '}') {
      return null;
    }
  }
  return null;
}

function normalizeCsv(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))]
    .sort()
    .join(',');
}

const lines = fs.readFileSync(capturedHtmlPath, 'utf8').split(/\r?\n/);
const requestPayloads = collectSeries(lines, '[/v1/messages] request-payload-json-chunk');
const invalidRequestPayloads = collectSeries(lines, '[compat-invalid-request-payload-json-chunk]');
const upstreamRequests = collectSeries(lines, '[compat-upstream-request-json-chunk]');
const upstreamResponses = collectSeries(lines, '[compat-upstream-response-json-chunk]');

const requestPayload = requestPayloads.find((entry) => String(entry?.value?.requestIdHeader ?? '') === requestId);
const invalidRequestPayload = invalidRequestPayloads.find((entry) => String(entry?.value?.request_id ?? '') === requestId);
const upstreamRequest = upstreamRequests.find((entry) => String(entry?.value?.request_id ?? '') === requestId);
const upstreamResponse = upstreamResponses.find((entry) => String(entry?.value?.request_id ?? '') === requestId);

if (!requestPayload && !invalidRequestPayload) {
  console.error(`error: no captured payload log found for ${requestId}`);
  process.exit(1);
}
if (!upstreamRequest) {
  console.error(`error: no captured upstream request log found for ${requestId}`);
  process.exit(1);
}
if (!upstreamResponse) {
  console.error(`error: no captured upstream response log found for ${requestId}`);
  process.exit(1);
}

const payload = invalidRequestPayload?.value?.payload ?? requestPayload?.value?.body;
let rawPayloadText = null;
let payloadExtractionMode = 'stable_json_fallback';
try {
  rawPayloadText = invalidRequestPayload
    ? extractTopLevelJsonValue(invalidRequestPayload.rawText, 'payload')
    : extractTopLevelJsonValue(requestPayload?.rawText ?? '', 'body');
} catch {
  rawPayloadText = null;
}
const payloadText = rawPayloadText && rawPayloadText.length > 0
  ? rawPayloadText
  : stableJson(payload ?? null);
if (rawPayloadText && rawPayloadText.length > 0) {
  payloadExtractionMode = invalidRequestPayload ? 'raw_invalid_request_payload' : 'raw_request_payload';
}
fs.writeFileSync(payloadPath, payloadText);

const headers = upstreamRequest.value.headers && typeof upstreamRequest.value.headers === 'object' ? upstreamRequest.value.headers : {};
const responseHeaders = upstreamResponse.value.response_headers && typeof upstreamResponse.value.response_headers === 'object'
  ? upstreamResponse.value.response_headers
  : {};
const parsedBody = upstreamResponse.value.parsed_body && typeof upstreamResponse.value.parsed_body === 'object'
  ? upstreamResponse.value.parsed_body
  : {};
const providerRequestId = responseHeaders['request-id']
  ?? responseHeaders['x-request-id']
  ?? parsedBody.request_id
  ?? '';

const values = {
  captured_request_id: String(requestId),
  payload_bytes: String(Buffer.byteLength(payloadText, 'utf8')),
  payload_sha256: sha256Hex(payloadText),
  payload_extraction_mode: payloadExtractionMode,
  captured_body_bytes: String(upstreamRequest.value.body_bytes ?? ''),
  captured_body_sha256: String(upstreamRequest.value.body_sha256 ?? ''),
  payload_matches_captured_sha: String(String(upstreamRequest.value.body_sha256 ?? '') === sha256Hex(payloadText)),
  captured_status: String(upstreamResponse.value.upstream_status ?? ''),
  captured_provider_request_id: String(providerRequestId),
  captured_provider: String(upstreamRequest.value.provider ?? ''),
  captured_target_url: String(upstreamRequest.value.target_url ?? ''),
  captured_accept: String(headers.accept ?? 'text/event-stream'),
  captured_content_type: String(headers['content-type'] ?? 'application/json'),
  captured_anthropic_version: String(headers['anthropic-version'] ?? '2023-06-01'),
  captured_anthropic_beta: String(headers['anthropic-beta'] ?? ''),
  captured_dangerous_direct_browser_access: String(headers['anthropic-dangerous-direct-browser-access'] ?? ''),
  captured_user_agent: String(headers['user-agent'] ?? ''),
  captured_x_app: String(headers['x-app'] ?? ''),
  captured_request_id_header: String(headers['x-request-id'] ?? ''),
  captured_header_names: normalizeCsv(Object.keys(headers))
};

for (const [key, value] of Object.entries(values)) {
  process.stdout.write(`${key}=${value}\n`);
}
NODE
}

CAPTURED_RESPONSE_HTML="${1:-${INNIES_CAPTURED_RESPONSE_HTML:-}}"
CAPTURED_REQUEST_ID="${2:-${INNIES_CAPTURED_REQUEST_ID:-}}"
require_nonempty 'captured response HTML' "$CAPTURED_RESPONSE_HTML"
require_nonempty 'captured Innies request id' "$CAPTURED_REQUEST_ID"

if [[ ! -f "$CAPTURED_RESPONSE_HTML" ]]; then
  echo "error: captured response HTML not found: $CAPTURED_RESPONSE_HTML" >&2
  exit 1
fi

DIRECT_TOKEN="${ANTHROPIC_OAUTH_ACCESS_TOKEN:-${CLAUDE_OAUTH_ACCESS_TOKEN:-}}"
if [[ -z "$DIRECT_TOKEN" ]]; then
  if ! DIRECT_TOKEN="$(prompt_secret 'Anthropic OAuth access token (press Enter to cancel)')"; then
    exit 1
  fi
fi
require_nonempty 'Anthropic OAuth access token' "$DIRECT_TOKEN"

DIRECT_BASE_URL="$(resolve_direct_base_url)"
OUT_DIR="${INNIES_HEADER_MATRIX_OUT_DIR:-${TMPDIR:-/tmp}/innies-compat-header-matrix-${CAPTURED_REQUEST_ID}}"
PAYLOAD_PATH="$OUT_DIR/payload.json"
SUMMARY_PATH="$OUT_DIR/summary.txt"
CAPTURED_META_PATH="$OUT_DIR/captured-meta.txt"
mkdir -p "$OUT_DIR"

CAPTURED_STATUS=''
CAPTURED_PROVIDER_REQUEST_ID=''
CAPTURED_PROVIDER=''
CAPTURED_TARGET_URL=''
CAPTURED_ACCEPT=''
CAPTURED_CONTENT_TYPE=''
CAPTURED_ANTHROPIC_VERSION=''
CAPTURED_ANTHROPIC_BETA=''
CAPTURED_DANGEROUS_DIRECT_BROWSER_ACCESS=''
CAPTURED_USER_AGENT=''
CAPTURED_X_APP=''
CAPTURED_REQUEST_ID_HEADER=''
CAPTURED_HEADER_NAMES=''
PAYLOAD_BYTES=''
PAYLOAD_SHA256=''
PAYLOAD_EXTRACTION_MODE=''
CAPTURED_BODY_BYTES=''
CAPTURED_BODY_SHA256=''
PAYLOAD_MATCHES_CAPTURED_SHA=''

while IFS='=' read -r key value; do
  case "$key" in
    payload_bytes) PAYLOAD_BYTES="$value" ;;
    payload_sha256) PAYLOAD_SHA256="$value" ;;
    payload_extraction_mode) PAYLOAD_EXTRACTION_MODE="$value" ;;
    captured_body_bytes) CAPTURED_BODY_BYTES="$value" ;;
    captured_body_sha256) CAPTURED_BODY_SHA256="$value" ;;
    payload_matches_captured_sha) PAYLOAD_MATCHES_CAPTURED_SHA="$value" ;;
    captured_status) CAPTURED_STATUS="$value" ;;
    captured_provider_request_id) CAPTURED_PROVIDER_REQUEST_ID="$value" ;;
    captured_provider) CAPTURED_PROVIDER="$value" ;;
    captured_target_url) CAPTURED_TARGET_URL="$value" ;;
    captured_accept) CAPTURED_ACCEPT="$value" ;;
    captured_content_type) CAPTURED_CONTENT_TYPE="$value" ;;
    captured_anthropic_version) CAPTURED_ANTHROPIC_VERSION="$value" ;;
    captured_anthropic_beta) CAPTURED_ANTHROPIC_BETA="$value" ;;
    captured_dangerous_direct_browser_access) CAPTURED_DANGEROUS_DIRECT_BROWSER_ACCESS="$value" ;;
    captured_user_agent) CAPTURED_USER_AGENT="$value" ;;
    captured_x_app) CAPTURED_X_APP="$value" ;;
    captured_request_id_header) CAPTURED_REQUEST_ID_HEADER="$value" ;;
    captured_header_names) CAPTURED_HEADER_NAMES="$value" ;;
  esac
done < <(load_captured_request "$CAPTURED_RESPONSE_HTML" "$CAPTURED_REQUEST_ID" "$PAYLOAD_PATH")

CALLER_ANTHROPIC_BETA="${INNIES_CALLER_ANTHROPIC_BETA:-${CAPTURED_ANTHROPIC_BETA%%,*}}"
if [[ -z "$CALLER_ANTHROPIC_BETA" ]]; then
  CALLER_ANTHROPIC_BETA="$CAPTURED_ANTHROPIC_BETA"
fi

write_lines "$CAPTURED_META_PATH" \
  "captured_response_html=$CAPTURED_RESPONSE_HTML" \
  "captured_request_id=$CAPTURED_REQUEST_ID" \
  "captured_status=${CAPTURED_STATUS:-}" \
  "captured_provider_request_id=${CAPTURED_PROVIDER_REQUEST_ID:-}" \
  "captured_provider=${CAPTURED_PROVIDER:-}" \
  "captured_target_url=${CAPTURED_TARGET_URL:-}" \
  "captured_header_names=${CAPTURED_HEADER_NAMES:-}" \
  "captured_anthropic_beta=${CAPTURED_ANTHROPIC_BETA:-}" \
  "captured_anthropic_version=${CAPTURED_ANTHROPIC_VERSION:-}" \
  "captured_dangerous_direct_browser_access=${CAPTURED_DANGEROUS_DIRECT_BROWSER_ACCESS:-}" \
  "captured_user_agent=${CAPTURED_USER_AGENT:-}" \
  "captured_x_app=${CAPTURED_X_APP:-}" \
  "captured_request_id_header=${CAPTURED_REQUEST_ID_HEADER:-}" \
  "payload_path=$PAYLOAD_PATH" \
  "payload_bytes=${PAYLOAD_BYTES:-}" \
  "payload_sha256=${PAYLOAD_SHA256:-}" \
  "payload_extraction_mode=${PAYLOAD_EXTRACTION_MODE:-}" \
  "captured_body_bytes=${CAPTURED_BODY_BYTES:-}" \
  "captured_body_sha256=${CAPTURED_BODY_SHA256:-}" \
  "payload_matches_captured_sha=${PAYLOAD_MATCHES_CAPTURED_SHA:-}"

CASE_LINES=()

run_case() {
  local case_id="$1"
  local anthropic_beta="$2"
  local include_identity_headers="$3"
  local include_request_id_header="$4"

  local request_id_header=''
  local dangerous_header=''
  local user_agent_header=''
  local x_app_header=''
  local header_names='accept,anthropic-beta,anthropic-version,authorization,content-type'
  local headers_file="$OUT_DIR/${case_id}-headers.txt"
  local body_file="$OUT_DIR/${case_id}-body.txt"
  local meta_file="$OUT_DIR/${case_id}-meta.txt"
  local case_status
  local provider_request_id
  local authorization_header
  local header_args=(
    -H "Authorization: Bearer $DIRECT_TOKEN"
    -H "Content-Type: $CAPTURED_CONTENT_TYPE"
    -H "Accept: $CAPTURED_ACCEPT"
    -H "anthropic-version: $CAPTURED_ANTHROPIC_VERSION"
    -H "anthropic-beta: $anthropic_beta"
  )

  if [[ "$include_identity_headers" == 'true' ]]; then
    if [[ -n "$CAPTURED_DANGEROUS_DIRECT_BROWSER_ACCESS" ]]; then
      dangerous_header="$CAPTURED_DANGEROUS_DIRECT_BROWSER_ACCESS"
      header_args+=(-H "anthropic-dangerous-direct-browser-access: $dangerous_header")
      header_names="${header_names},anthropic-dangerous-direct-browser-access"
    fi
    if [[ -n "$CAPTURED_USER_AGENT" ]]; then
      user_agent_header="$CAPTURED_USER_AGENT"
      header_args+=(-H "user-agent: $user_agent_header")
      header_names="${header_names},user-agent"
    fi
    if [[ -n "$CAPTURED_X_APP" ]]; then
      x_app_header="$CAPTURED_X_APP"
      header_args+=(-H "x-app: $x_app_header")
      header_names="${header_names},x-app"
    fi
  else
    header_args+=(-H 'user-agent:')
  fi

  if [[ "$include_request_id_header" == 'true' ]]; then
    request_id_header="${CAPTURED_REQUEST_ID}__${case_id}"
    header_args+=(-H "x-request-id: $request_id_header")
    header_names="${header_names},x-request-id"
  fi

  case_status="$(curl -sS -D "$headers_file" -o "$body_file" -w '%{http_code}' \
    -X POST "${DIRECT_BASE_URL}/v1/messages" \
    "${header_args[@]}" \
    --data-binary @"$PAYLOAD_PATH")"

  provider_request_id="$(extract_header 'request-id' "$headers_file")"
  if [[ -z "$provider_request_id" ]]; then
    provider_request_id="$(extract_body_request_id "$body_file")"
  fi
  authorization_header="$(redact_bearer_value "$DIRECT_TOKEN")"

  write_lines "$meta_file" \
    "case_id=$case_id" \
    "status=$case_status" \
    "provider_request_id=${provider_request_id:-}" \
    "target_url=${DIRECT_BASE_URL}/v1/messages" \
    "authorization=$authorization_header" \
    "accept=$CAPTURED_ACCEPT" \
    "content_type=$CAPTURED_CONTENT_TYPE" \
    "anthropic_version=$CAPTURED_ANTHROPIC_VERSION" \
    "anthropic_beta=$anthropic_beta" \
    "dangerous_direct_browser_access=${dangerous_header:-}" \
    "user_agent=${user_agent_header:-}" \
    "x_app=${x_app_header:-}" \
    "request_id_header=${request_id_header:-}" \
    "header_names=$header_names" \
    "headers_file=$headers_file" \
    "body_file=$body_file"

  CASE_LINES+=("case=$case_id status=$case_status provider_request_id=${provider_request_id:-} anthropic_beta=$anthropic_beta x_app=${x_app_header:-} user_agent=${user_agent_header:-} dangerous_direct_browser_access=${dangerous_header:-} request_id_header=${request_id_header:-}")
}

run_case 'captured-baseline' "$CAPTURED_ANTHROPIC_BETA" 'true' 'true'
run_case 'caller-beta-only' "$CALLER_ANTHROPIC_BETA" 'true' 'true'
run_case 'identity-headers-removed' "$CAPTURED_ANTHROPIC_BETA" 'false' 'true'
run_case 'caller-beta-only-no-identity-headers' "$CALLER_ANTHROPIC_BETA" 'false' 'true'
run_case 'no-request-id' "$CAPTURED_ANTHROPIC_BETA" 'true' 'false'

SUMMARY_LINES=(
  "captured_response_html=$CAPTURED_RESPONSE_HTML"
  "captured_request_id=$CAPTURED_REQUEST_ID"
  "captured_status=${CAPTURED_STATUS:-}"
  "captured_provider_request_id=${CAPTURED_PROVIDER_REQUEST_ID:-}"
  "captured_provider=${CAPTURED_PROVIDER:-}"
  "captured_target_url=${CAPTURED_TARGET_URL:-}"
  "captured_header_names=${CAPTURED_HEADER_NAMES:-}"
  "captured_anthropic_beta=${CAPTURED_ANTHROPIC_BETA:-}"
  "captured_anthropic_version=${CAPTURED_ANTHROPIC_VERSION:-}"
  "payload_path=$PAYLOAD_PATH"
  "payload_bytes=${PAYLOAD_BYTES:-}"
  "payload_sha256=${PAYLOAD_SHA256:-}"
  "payload_extraction_mode=${PAYLOAD_EXTRACTION_MODE:-}"
  "captured_body_bytes=${CAPTURED_BODY_BYTES:-}"
  "captured_body_sha256=${CAPTURED_BODY_SHA256:-}"
  "payload_matches_captured_sha=${PAYLOAD_MATCHES_CAPTURED_SHA:-}"
  "case_count=${#CASE_LINES[@]}"
)

write_lines "$SUMMARY_PATH" "${SUMMARY_LINES[@]}" "${CASE_LINES[@]}"
cat "$SUMMARY_PATH"
printf 'summary_file=%s\n' "$SUMMARY_PATH"
