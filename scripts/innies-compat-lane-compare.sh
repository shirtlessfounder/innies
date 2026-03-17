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

resolve_api_url() {
  if [[ -n "${INNIES_BASE_URL:-}" ]]; then
    printf '%s' "${INNIES_BASE_URL%/}"
    return
  fi
  if [[ -n "${INNIES_API_BASE_URL:-}" ]]; then
    printf '%s' "${INNIES_API_BASE_URL%/}"
    return
  fi
  if [[ -n "${INNIES_API_URL:-}" ]]; then
    printf '%s' "${INNIES_API_URL%/}"
    return
  fi
  printf '%s' "${BASE_URL%/}"
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

write_lines() {
  local file="$1"
  shift
  printf '%s\n' "$@" >"$file"
}

normalize_csv() {
  local value="${1:-}"
  if [[ -z "$value" ]]; then
    printf '%s' ''
    return
  fi
  printf '%s' "$value" \
    | tr ',' '\n' \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
    | sed '/^$/d' \
    | sort -u \
    | paste -sd',' -
}

csv_only_in_left() {
  local left="${1:-}"
  local right="${2:-}"
  comm -23 \
    <(printf '%s' "$left" | tr ',' '\n' | sed '/^$/d' | sort -u) \
    <(printf '%s' "$right" | tr ',' '\n' | sed '/^$/d' | sort -u) \
    | paste -sd',' -
}

redact_bearer_value() {
  local token="$1"
  printf 'Bearer <redacted:%s>' "${#token}"
}

load_captured_innies_lane() {
  local captured_html="$1"
  local request_id="$2"
  node - "$captured_html" "$request_id" <<'NODE'
const fs = require('fs');

const capturedHtmlPath = process.argv[2];
const requestId = process.argv[3];

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
    else if (expectedChunkCount !== chunkCount) throw new Error(`Mismatched ${label} chunk_count near line ${index + 1}`);
    if (chunkIndex !== parts.length) throw new Error(`Out-of-order ${label} chunk_index near line ${index + 1}`);
    parts.push(parseJsLiteral(jsonMatch[1]));
    index += 5;
    if (parts.length === expectedChunkCount) {
      return { text: parts.join(''), nextIndex: index - 1 };
    }
  }
  throw new Error(`Incomplete ${label} chunk series near line ${startIndex + 1}`);
}

function readRequestId(value) {
  const raw = value?.request_id ?? value?.requestId;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function normalizeCsv(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))]
    .sort()
    .join(',');
}

function inferTokenKind(provider, authorization) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    return 'api_key';
  }
  if (provider === 'anthropic') return 'anthropic_oauth';
  if (provider === 'openai') return 'openai_oauth';
  return 'bearer';
}

const lines = fs.readFileSync(capturedHtmlPath, 'utf8').split(/\r?\n/);
const upstreamRequests = [];
const upstreamResponses = [];
for (let index = 0; index < lines.length; index += 1) {
  const body = stripLogPrefix(lines[index]);
  if (body === '[compat-upstream-request-json-chunk] {') {
    const { text, nextIndex } = parseChunkSeries(lines, index, '[compat-upstream-request-json-chunk]');
    upstreamRequests.push(parseSerializedValue(text));
    index = nextIndex;
    continue;
  }
  if (body === '[compat-upstream-response-json-chunk] {') {
    const { text, nextIndex } = parseChunkSeries(lines, index, '[compat-upstream-response-json-chunk]');
    upstreamResponses.push(parseSerializedValue(text));
    index = nextIndex;
  }
}

const upstreamRequest = upstreamRequests.find((value) => readRequestId(value) === requestId);
if (!upstreamRequest) {
  console.error(`error: no captured compat upstream request found for ${requestId}`);
  process.exit(1);
}
const upstreamResponse = upstreamResponses.find((value) => readRequestId(value) === requestId);
if (!upstreamResponse) {
  console.error(`error: no captured compat upstream response found for ${requestId}`);
  process.exit(1);
}

const headers = upstreamRequest.headers && typeof upstreamRequest.headers === 'object' ? upstreamRequest.headers : {};
const responseHeaders = upstreamResponse.response_headers && typeof upstreamResponse.response_headers === 'object'
  ? upstreamResponse.response_headers
  : {};
const parsedBody = upstreamResponse.parsed_body && typeof upstreamResponse.parsed_body === 'object'
  ? upstreamResponse.parsed_body
  : {};
const providerRequestId = responseHeaders['request-id']
  ?? responseHeaders['x-request-id']
  ?? parsedBody.request_id
  ?? '';

const values = {
  status: String(upstreamResponse.upstream_status ?? ''),
  request_id: String(requestId),
  response_request_id: String(upstreamResponse.request_id ?? requestId),
  forwarded_request_id: String(upstreamRequest.request_id ?? requestId),
  provider_request_id: String(providerRequestId),
  token_credential_id: String(upstreamRequest.credential_id ?? upstreamResponse.credential_id ?? ''),
  attempt_no: String(upstreamRequest.attempt_no ?? upstreamResponse.attempt_no ?? ''),
  upstream_target_url: String(upstreamRequest.target_url ?? ''),
  upstream_proxied_path: String(upstreamRequest.proxied_path ?? ''),
  upstream_provider: String(upstreamRequest.provider ?? ''),
  upstream_stream: String(Boolean(upstreamRequest.stream)),
  upstream_credential_id: String(upstreamRequest.credential_id ?? upstreamResponse.credential_id ?? ''),
  upstream_token_kind: inferTokenKind(String(upstreamRequest.provider ?? ''), String(headers.authorization ?? '')),
  upstream_authorization: String(headers.authorization ?? ''),
  upstream_accept: String(headers.accept ?? ''),
  upstream_anthropic_version: String(headers['anthropic-version'] ?? ''),
  upstream_anthropic_beta: String(headers['anthropic-beta'] ?? ''),
  upstream_user_agent: String(headers['user-agent'] ?? ''),
  upstream_header_names: normalizeCsv(Object.keys(headers))
};

for (const [key, value] of Object.entries(values)) {
  process.stdout.write(`${key}=${value}\n`);
}
NODE
}

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

PAYLOAD_PATH="${1:-${INNIES_REPLAY_PAYLOAD_PATH:-}}"
require_nonempty 'payload path' "$PAYLOAD_PATH"

if [[ ! -f "$PAYLOAD_PATH" ]]; then
  echo "error: payload file not found: $PAYLOAD_PATH" >&2
  exit 1
fi

CAPTURED_RESPONSE_HTML="${INNIES_CAPTURED_RESPONSE_HTML:-${INNIES_CAPTURED_LOG_PATH:-}}"
CAPTURED_REQUEST_ID="${INNIES_CAPTURED_REQUEST_ID:-${INNIES_REQUEST_ID:-}}"
USE_CAPTURED_RESPONSE='false'
if [[ -n "$CAPTURED_RESPONSE_HTML" ]]; then
  if [[ ! -f "$CAPTURED_RESPONSE_HTML" ]]; then
    echo "error: captured response HTML not found: $CAPTURED_RESPONSE_HTML" >&2
    exit 1
  fi
  require_nonempty 'captured Innies request id' "$CAPTURED_REQUEST_ID"
  USE_CAPTURED_RESPONSE='true'
fi

if [[ "$USE_CAPTURED_RESPONSE" != 'true' ]]; then
  API_URL="$(resolve_api_url)"
  BUYER_TOKEN="${INNIES_BUYER_API_KEY:-${INNIES_TOKEN:-${BUYER_TOKEN:-}}}"
  if [[ -z "$BUYER_TOKEN" ]]; then
    if ! BUYER_TOKEN="$(prompt_secret 'buyer API key (press Enter to cancel)')"; then
      exit 1
    fi
  fi
  require_nonempty 'buyer API key' "$BUYER_TOKEN"
fi

DIRECT_TOKEN="${ANTHROPIC_OAUTH_ACCESS_TOKEN:-${CLAUDE_OAUTH_ACCESS_TOKEN:-}}"
if [[ -z "$DIRECT_TOKEN" ]]; then
  if ! DIRECT_TOKEN="$(prompt_secret 'Anthropic OAuth access token (press Enter to cancel)')"; then
    exit 1
  fi
fi
require_nonempty 'Anthropic OAuth access token' "$DIRECT_TOKEN"

ANTHROPIC_VERSION="${INNIES_ANTHROPIC_VERSION:-2023-06-01}"
ANTHROPIC_BETA="${INNIES_ANTHROPIC_BETA:-fine-grained-tool-streaming-2025-05-14}"
INNIES_REQUEST_ID="${INNIES_REQUEST_ID:-${CAPTURED_REQUEST_ID:-req_issue80_innies_$(date -u +%Y%m%dT%H%M%SZ)}}"
DIRECT_REQUEST_ID="${ANTHROPIC_DIRECT_REQUEST_ID:-req_issue80_direct_$(date -u +%Y%m%dT%H%M%SZ)}"
DIRECT_BASE_URL="$(resolve_direct_base_url)"
DIRECT_VERSION="${ANTHROPIC_DIRECT_VERSION:-$ANTHROPIC_VERSION}"
DIRECT_BETA="${ANTHROPIC_DIRECT_BETA:-$ANTHROPIC_BETA}"
DIRECT_USER_AGENT="${ANTHROPIC_DIRECT_USER_AGENT:-}"
OUT_DIR="${INNIES_LANE_OUT_DIR:-${TMPDIR:-/tmp}/innies-compat-lane-compare-${INNIES_REQUEST_ID}}"
PAYLOAD_BYTES="$(wc -c <"$PAYLOAD_PATH" | tr -d ' ')"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "$OUT_DIR"

INNIES_HEADERS_FILE="$OUT_DIR/innies-headers.txt"
INNIES_BODY_FILE="$OUT_DIR/innies-body.txt"
INNIES_META_FILE="$OUT_DIR/innies-meta.txt"
DIRECT_HEADERS_FILE="$OUT_DIR/direct-headers.txt"
DIRECT_BODY_FILE="$OUT_DIR/direct-body.txt"
DIRECT_META_FILE="$OUT_DIR/direct-meta.txt"
COMPARISON_FILE="$OUT_DIR/comparison.txt"

INNIES_STATUS=''
INNIES_RESPONSE_REQUEST_ID=''
INNIES_TOKEN_CREDENTIAL_ID=''
INNIES_ATTEMPT_NO=''
INNIES_UPSTREAM_TARGET_URL=''
INNIES_UPSTREAM_PROXIED_PATH=''
INNIES_UPSTREAM_PROVIDER=''
INNIES_UPSTREAM_STREAM=''
INNIES_UPSTREAM_CREDENTIAL_ID=''
INNIES_UPSTREAM_TOKEN_KIND=''
INNIES_UPSTREAM_AUTHORIZATION=''
INNIES_UPSTREAM_ACCEPT=''
INNIES_UPSTREAM_ANTHROPIC_VERSION=''
INNIES_UPSTREAM_ANTHROPIC_BETA=''
INNIES_UPSTREAM_USER_AGENT=''
INNIES_FORWARDED_REQUEST_ID=''
INNIES_UPSTREAM_HEADER_NAMES=''
INNIES_PROVIDER_REQUEST_ID=''

if [[ "$USE_CAPTURED_RESPONSE" == 'true' ]]; then
  while IFS='=' read -r key value; do
    case "$key" in
      status) INNIES_STATUS="$value" ;;
      request_id) INNIES_REQUEST_ID="$value" ;;
      response_request_id) INNIES_RESPONSE_REQUEST_ID="$value" ;;
      forwarded_request_id) INNIES_FORWARDED_REQUEST_ID="$value" ;;
      provider_request_id) INNIES_PROVIDER_REQUEST_ID="$value" ;;
      token_credential_id) INNIES_TOKEN_CREDENTIAL_ID="$value" ;;
      attempt_no) INNIES_ATTEMPT_NO="$value" ;;
      upstream_target_url) INNIES_UPSTREAM_TARGET_URL="$value" ;;
      upstream_proxied_path) INNIES_UPSTREAM_PROXIED_PATH="$value" ;;
      upstream_provider) INNIES_UPSTREAM_PROVIDER="$value" ;;
      upstream_stream) INNIES_UPSTREAM_STREAM="$value" ;;
      upstream_credential_id) INNIES_UPSTREAM_CREDENTIAL_ID="$value" ;;
      upstream_token_kind) INNIES_UPSTREAM_TOKEN_KIND="$value" ;;
      upstream_authorization) INNIES_UPSTREAM_AUTHORIZATION="$value" ;;
      upstream_accept) INNIES_UPSTREAM_ACCEPT="$value" ;;
      upstream_anthropic_version) INNIES_UPSTREAM_ANTHROPIC_VERSION="$value" ;;
      upstream_anthropic_beta) INNIES_UPSTREAM_ANTHROPIC_BETA="$value" ;;
      upstream_user_agent) INNIES_UPSTREAM_USER_AGENT="$value" ;;
      upstream_header_names) INNIES_UPSTREAM_HEADER_NAMES="$value" ;;
    esac
  done < <(load_captured_innies_lane "$CAPTURED_RESPONSE_HTML" "$CAPTURED_REQUEST_ID")
else
  INNIES_STATUS="$(curl -sS -D "$INNIES_HEADERS_FILE" -o "$INNIES_BODY_FILE" -w '%{http_code}' \
    -X POST "${API_URL}/v1/messages" \
    -H "Authorization: Bearer $BUYER_TOKEN" \
    -H 'Content-Type: application/json' \
    -H 'Accept: text/event-stream' \
    -H "anthropic-version: $ANTHROPIC_VERSION" \
    -H "anthropic-beta: $ANTHROPIC_BETA" \
    -H "x-request-id: $INNIES_REQUEST_ID" \
    -H 'x-innies-debug-upstream-lane: 1' \
    --data-binary @"$PAYLOAD_PATH")"

  INNIES_RESPONSE_REQUEST_ID="$(extract_header 'x-request-id' "$INNIES_HEADERS_FILE")"
  INNIES_TOKEN_CREDENTIAL_ID="$(extract_header 'x-innies-token-credential-id' "$INNIES_HEADERS_FILE")"
  INNIES_ATTEMPT_NO="$(extract_header 'x-innies-attempt-no' "$INNIES_HEADERS_FILE")"
  INNIES_UPSTREAM_TARGET_URL="$(extract_header 'x-innies-debug-upstream-target-url' "$INNIES_HEADERS_FILE")"
  INNIES_UPSTREAM_PROXIED_PATH="$(extract_header 'x-innies-debug-upstream-proxied-path' "$INNIES_HEADERS_FILE")"
  INNIES_UPSTREAM_PROVIDER="$(extract_header 'x-innies-debug-upstream-provider' "$INNIES_HEADERS_FILE")"
  INNIES_UPSTREAM_STREAM="$(extract_header 'x-innies-debug-upstream-stream' "$INNIES_HEADERS_FILE")"
  INNIES_UPSTREAM_CREDENTIAL_ID="$(extract_header 'x-innies-debug-upstream-credential-id' "$INNIES_HEADERS_FILE")"
  INNIES_UPSTREAM_TOKEN_KIND="$(extract_header 'x-innies-debug-upstream-token-kind' "$INNIES_HEADERS_FILE")"
  INNIES_UPSTREAM_AUTHORIZATION="$(extract_header 'x-innies-debug-upstream-authorization' "$INNIES_HEADERS_FILE")"
  INNIES_UPSTREAM_ACCEPT="$(extract_header 'x-innies-debug-upstream-accept' "$INNIES_HEADERS_FILE")"
  INNIES_UPSTREAM_ANTHROPIC_VERSION="$(extract_header 'x-innies-debug-upstream-anthropic-version' "$INNIES_HEADERS_FILE")"
  INNIES_UPSTREAM_ANTHROPIC_BETA="$(extract_header 'x-innies-debug-upstream-anthropic-beta' "$INNIES_HEADERS_FILE")"
  INNIES_UPSTREAM_USER_AGENT="$(extract_header 'x-innies-debug-upstream-user-agent' "$INNIES_HEADERS_FILE")"
  INNIES_FORWARDED_REQUEST_ID="$(extract_header 'x-innies-debug-upstream-request-id' "$INNIES_HEADERS_FILE")"
  INNIES_UPSTREAM_HEADER_NAMES="$(normalize_csv "$(extract_header 'x-innies-debug-upstream-header-names' "$INNIES_HEADERS_FILE")")"
  INNIES_PROVIDER_REQUEST_ID="$(extract_header 'request-id' "$INNIES_HEADERS_FILE")"
  if [[ -z "$INNIES_PROVIDER_REQUEST_ID" ]]; then
    INNIES_PROVIDER_REQUEST_ID="$(extract_body_request_id "$INNIES_BODY_FILE")"
  fi
fi

if [[ -z "$INNIES_UPSTREAM_TARGET_URL" ]]; then
  if [[ "$USE_CAPTURED_RESPONSE" == 'true' ]]; then
    echo "error: captured response did not contain an Innies upstream lane for request $CAPTURED_REQUEST_ID" >&2
  else
    echo 'error: missing x-innies-debug-upstream-target-url response header; enable INNIES_ENABLE_UPSTREAM_DEBUG_HEADERS=true on the API server' >&2
  fi
  exit 1
fi

write_lines "$INNIES_META_FILE" \
  "timestamp=$TIMESTAMP" \
  "payload_path=$PAYLOAD_PATH" \
  "captured_response_html=${CAPTURED_RESPONSE_HTML:-}" \
  "payload_bytes=$PAYLOAD_BYTES" \
  "status=$INNIES_STATUS" \
  "request_id=$INNIES_REQUEST_ID" \
  "response_request_id=${INNIES_RESPONSE_REQUEST_ID:-}" \
  "forwarded_request_id=${INNIES_FORWARDED_REQUEST_ID:-}" \
  "provider_request_id=${INNIES_PROVIDER_REQUEST_ID:-}" \
  "token_credential_id=${INNIES_TOKEN_CREDENTIAL_ID:-}" \
  "attempt_no=${INNIES_ATTEMPT_NO:-}" \
  "upstream_target_url=${INNIES_UPSTREAM_TARGET_URL:-}" \
  "upstream_proxied_path=${INNIES_UPSTREAM_PROXIED_PATH:-}" \
  "upstream_provider=${INNIES_UPSTREAM_PROVIDER:-}" \
  "upstream_stream=${INNIES_UPSTREAM_STREAM:-}" \
  "upstream_credential_id=${INNIES_UPSTREAM_CREDENTIAL_ID:-}" \
  "upstream_token_kind=${INNIES_UPSTREAM_TOKEN_KIND:-}" \
  "upstream_authorization=${INNIES_UPSTREAM_AUTHORIZATION:-}" \
  "upstream_accept=${INNIES_UPSTREAM_ACCEPT:-}" \
  "upstream_anthropic_version=${INNIES_UPSTREAM_ANTHROPIC_VERSION:-}" \
  "upstream_anthropic_beta=${INNIES_UPSTREAM_ANTHROPIC_BETA:-}" \
  "upstream_user_agent=${INNIES_UPSTREAM_USER_AGENT:-}" \
  "upstream_header_names=${INNIES_UPSTREAM_HEADER_NAMES:-}" \
  "headers_file=$INNIES_HEADERS_FILE" \
  "body_file=$INNIES_BODY_FILE"

DIRECT_HEADER_NAMES='accept,anthropic-beta,anthropic-version,authorization,content-type,x-request-id'
if [[ -n "$DIRECT_USER_AGENT" ]]; then
  DIRECT_HEADER_NAMES="${DIRECT_HEADER_NAMES},user-agent"
fi
DIRECT_HEADER_NAMES="$(normalize_csv "$DIRECT_HEADER_NAMES")"

DIRECT_CURL_ARGS=(
  -sS
  -D "$DIRECT_HEADERS_FILE"
  -o "$DIRECT_BODY_FILE"
  -w '%{http_code}'
  -X POST "${DIRECT_BASE_URL}/v1/messages"
  -H "Authorization: Bearer $DIRECT_TOKEN"
  -H 'Content-Type: application/json'
  -H 'Accept: text/event-stream'
  -H "anthropic-version: $DIRECT_VERSION"
  -H "anthropic-beta: $DIRECT_BETA"
  -H "x-request-id: $DIRECT_REQUEST_ID"
)
if [[ -n "$DIRECT_USER_AGENT" ]]; then
  DIRECT_CURL_ARGS+=(-H "user-agent: $DIRECT_USER_AGENT")
fi
DIRECT_CURL_ARGS+=(--data-binary @"$PAYLOAD_PATH")
DIRECT_STATUS="$(curl "${DIRECT_CURL_ARGS[@]}")"

DIRECT_RESPONSE_REQUEST_ID="$(extract_header 'x-request-id' "$DIRECT_HEADERS_FILE")"
DIRECT_PROVIDER_REQUEST_ID="$(extract_header 'request-id' "$DIRECT_HEADERS_FILE")"
if [[ -z "$DIRECT_PROVIDER_REQUEST_ID" ]]; then
  DIRECT_PROVIDER_REQUEST_ID="$(extract_body_request_id "$DIRECT_BODY_FILE")"
fi
DIRECT_AUTHORIZATION="$(redact_bearer_value "$DIRECT_TOKEN")"
DIRECT_TOKEN_KIND='bearer'
if [[ "$DIRECT_TOKEN" == sk-ant-oat* ]]; then
  DIRECT_TOKEN_KIND='anthropic_oauth'
fi

write_lines "$DIRECT_META_FILE" \
  "timestamp=$TIMESTAMP" \
  "payload_path=$PAYLOAD_PATH" \
  "payload_bytes=$PAYLOAD_BYTES" \
  "status=$DIRECT_STATUS" \
  "request_id=$DIRECT_REQUEST_ID" \
  "response_request_id=${DIRECT_RESPONSE_REQUEST_ID:-}" \
  "provider_request_id=${DIRECT_PROVIDER_REQUEST_ID:-}" \
  "target_url=${DIRECT_BASE_URL}/v1/messages" \
  "token_kind=$DIRECT_TOKEN_KIND" \
  "authorization=$DIRECT_AUTHORIZATION" \
  "accept=text/event-stream" \
  "anthropic_version=$DIRECT_VERSION" \
  "anthropic_beta=$DIRECT_BETA" \
  "user_agent=${DIRECT_USER_AGENT:-}" \
  "header_names=$DIRECT_HEADER_NAMES" \
  "headers_file=$DIRECT_HEADERS_FILE" \
  "body_file=$DIRECT_BODY_FILE"

SHARED_HEADER_NAMES="$(normalize_csv "$(comm -12 \
  <(printf '%s' "$INNIES_UPSTREAM_HEADER_NAMES" | tr ',' '\n' | sed '/^$/d' | sort -u) \
  <(printf '%s' "$DIRECT_HEADER_NAMES" | tr ',' '\n' | sed '/^$/d' | sort -u) \
  | paste -sd',' -)")"
INNIES_ONLY_HEADER_NAMES="$(csv_only_in_left "$INNIES_UPSTREAM_HEADER_NAMES" "$DIRECT_HEADER_NAMES")"
DIRECT_ONLY_HEADER_NAMES="$(csv_only_in_left "$DIRECT_HEADER_NAMES" "$INNIES_UPSTREAM_HEADER_NAMES")"

HEADER_VALUE_DIFF_NAMES=''
if [[ "${INNIES_UPSTREAM_ACCEPT:-}" != 'text/event-stream' ]]; then
  HEADER_VALUE_DIFF_NAMES="$(normalize_csv "${HEADER_VALUE_DIFF_NAMES},accept")"
fi
if [[ "${INNIES_UPSTREAM_ANTHROPIC_VERSION:-}" != "$DIRECT_VERSION" ]]; then
  HEADER_VALUE_DIFF_NAMES="$(normalize_csv "${HEADER_VALUE_DIFF_NAMES},anthropic-version")"
fi
if [[ "${INNIES_UPSTREAM_ANTHROPIC_BETA:-}" != "$DIRECT_BETA" ]]; then
  HEADER_VALUE_DIFF_NAMES="$(normalize_csv "${HEADER_VALUE_DIFF_NAMES},anthropic-beta")"
fi
if [[ "${INNIES_UPSTREAM_AUTHORIZATION:-}" != "$DIRECT_AUTHORIZATION" ]]; then
  HEADER_VALUE_DIFF_NAMES="$(normalize_csv "${HEADER_VALUE_DIFF_NAMES},authorization")"
fi
if [[ "${INNIES_UPSTREAM_USER_AGENT:-}" != "$DIRECT_USER_AGENT" ]]; then
  HEADER_VALUE_DIFF_NAMES="$(normalize_csv "${HEADER_VALUE_DIFF_NAMES},user-agent")"
fi

write_lines "$COMPARISON_FILE" \
  "timestamp=$TIMESTAMP" \
  "payload_path=$PAYLOAD_PATH" \
  "payload_bytes=$PAYLOAD_BYTES" \
  "innies_status=$INNIES_STATUS" \
  "innies_request_id=$INNIES_REQUEST_ID" \
  "innies_response_request_id=${INNIES_RESPONSE_REQUEST_ID:-}" \
  "innies_forwarded_request_id=${INNIES_FORWARDED_REQUEST_ID:-}" \
  "innies_provider_request_id=${INNIES_PROVIDER_REQUEST_ID:-}" \
  "innies_token_credential_id=${INNIES_TOKEN_CREDENTIAL_ID:-}" \
  "innies_attempt_no=${INNIES_ATTEMPT_NO:-}" \
  "innies_upstream_target_url=${INNIES_UPSTREAM_TARGET_URL:-}" \
  "innies_upstream_proxied_path=${INNIES_UPSTREAM_PROXIED_PATH:-}" \
  "innies_upstream_provider=${INNIES_UPSTREAM_PROVIDER:-}" \
  "innies_upstream_stream=${INNIES_UPSTREAM_STREAM:-}" \
  "innies_upstream_credential_id=${INNIES_UPSTREAM_CREDENTIAL_ID:-}" \
  "innies_upstream_token_kind=${INNIES_UPSTREAM_TOKEN_KIND:-}" \
  "innies_upstream_authorization=${INNIES_UPSTREAM_AUTHORIZATION:-}" \
  "innies_upstream_accept=${INNIES_UPSTREAM_ACCEPT:-}" \
  "innies_upstream_anthropic_version=${INNIES_UPSTREAM_ANTHROPIC_VERSION:-}" \
  "innies_upstream_anthropic_beta=${INNIES_UPSTREAM_ANTHROPIC_BETA:-}" \
  "innies_upstream_user_agent=${INNIES_UPSTREAM_USER_AGENT:-}" \
  "innies_upstream_header_names=${INNIES_UPSTREAM_HEADER_NAMES:-}" \
  "direct_status=$DIRECT_STATUS" \
  "direct_request_id=$DIRECT_REQUEST_ID" \
  "direct_response_request_id=${DIRECT_RESPONSE_REQUEST_ID:-}" \
  "direct_provider_request_id=${DIRECT_PROVIDER_REQUEST_ID:-}" \
  "direct_target_url=${DIRECT_BASE_URL}/v1/messages" \
  "direct_token_kind=$DIRECT_TOKEN_KIND" \
  "direct_authorization=$DIRECT_AUTHORIZATION" \
  "direct_accept=text/event-stream" \
  "direct_anthropic_version=$DIRECT_VERSION" \
  "direct_anthropic_beta=$DIRECT_BETA" \
  "direct_user_agent=${DIRECT_USER_AGENT:-}" \
  "direct_header_names=$DIRECT_HEADER_NAMES" \
  "shared_header_names=${SHARED_HEADER_NAMES:-}" \
  "innies_only_header_names=${INNIES_ONLY_HEADER_NAMES:-}" \
  "direct_only_header_names=${DIRECT_ONLY_HEADER_NAMES:-}" \
  "header_value_diff_names=${HEADER_VALUE_DIFF_NAMES:-}"

cat "$COMPARISON_FILE"
printf 'comparison_file=%s\n' "$COMPARISON_FILE"
