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

write_lines() {
  local file="$1"
  shift
  printf '%s\n' "$@" >"$file"
}

extract_captured_request() {
  local captured_html="$1"
  local request_id="$2"
  local headers_tsv="$3"
  local meta_file="$4"
  node - "$captured_html" "$request_id" "$headers_tsv" "$meta_file" <<'NODE'
const fs = require('fs');

const capturedHtmlPath = process.argv[2];
const requestId = process.argv[3];
const headersPath = process.argv[4];
const metaPath = process.argv[5];

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
    if (expectedChunkCount === null) {
      expectedChunkCount = chunkCount;
    } else if (expectedChunkCount !== chunkCount) {
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

const lines = fs.readFileSync(capturedHtmlPath, 'utf8').split(/\r?\n/);
const upstreamRequests = [];
for (let index = 0; index < lines.length; index += 1) {
  const body = stripLogPrefix(lines[index]);
  if (body === '[compat-upstream-request-json-chunk] {') {
    const { text, nextIndex } = parseChunkSeries(lines, index, '[compat-upstream-request-json-chunk]');
    upstreamRequests.push(parseSerializedValue(text));
    index = nextIndex;
  }
}

const request = upstreamRequests.find((value) => value?.request_id === requestId);
if (!request) {
  console.error(`error: no captured compat upstream request found for ${requestId}`);
  process.exit(1);
}

const headers = request.headers && typeof request.headers === 'object' ? request.headers : {};
const headerLines = Object.entries(headers).map(([name, value]) => `${name}\t${String(value)}`);
fs.writeFileSync(headersPath, `${headerLines.join('\n')}\n`);
fs.writeFileSync(metaPath, [
  `captured_request_id=${request.request_id ?? ''}`,
  `captured_provider=${request.provider ?? ''}`,
  `captured_target_url=${request.target_url ?? ''}`,
  `captured_proxied_path=${request.proxied_path ?? ''}`,
  `captured_attempt_no=${request.attempt_no ?? ''}`,
  `captured_stream=${String(Boolean(request.stream))}`,
  `captured_body_bytes=${request.body_bytes ?? ''}`
].join('\n') + '\n');
NODE
}

PAYLOAD_PATH="${1:-${INNIES_REPLAY_PAYLOAD_PATH:-}}"
require_nonempty 'payload path' "$PAYLOAD_PATH"

if [[ ! -f "$PAYLOAD_PATH" ]]; then
  echo "error: payload file not found: $PAYLOAD_PATH" >&2
  exit 1
fi

CAPTURED_RESPONSE_HTML="${INNIES_CAPTURED_RESPONSE_HTML:-${INNIES_CAPTURED_LOG_PATH:-}}"
CAPTURED_REQUEST_ID="${INNIES_CAPTURED_REQUEST_ID:-${INNIES_REQUEST_ID:-}}"
require_nonempty 'captured response HTML' "$CAPTURED_RESPONSE_HTML"
require_nonempty 'captured request id' "$CAPTURED_REQUEST_ID"

if [[ ! -f "$CAPTURED_RESPONSE_HTML" ]]; then
  echo "error: captured response HTML not found: $CAPTURED_RESPONSE_HTML" >&2
  exit 1
fi

DIRECT_BASE_URL="$(resolve_direct_base_url)"
ACCESS_TOKEN="${ANTHROPIC_OAUTH_ACCESS_TOKEN:-${ANTHROPIC_ACCESS_TOKEN:-${CLAUDE_CODE_OAUTH_TOKEN:-}}}"
require_nonempty 'Anthropic OAuth access token' "$ACCESS_TOKEN"

DIRECT_REQUEST_ID="${INNIES_DIRECT_REQUEST_ID:-req_issue80_direct_$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="${INNIES_REPLAY_OUT_DIR:-${TMPDIR:-/tmp}/innies-compat-captured-lane-replay-${DIRECT_REQUEST_ID}}"
mkdir -p "$OUT_DIR"

CAPTURED_HEADERS_FILE="$OUT_DIR/captured-headers.tsv"
CAPTURED_META_FILE="$OUT_DIR/captured-meta.txt"
DIRECT_HEADERS_FILE="$OUT_DIR/direct-headers.txt"
DIRECT_BODY_FILE="$OUT_DIR/direct-body.txt"
META_FILE="$OUT_DIR/meta.txt"
PAYLOAD_BYTES="$(wc -c <"$PAYLOAD_PATH" | tr -d ' ')"

extract_captured_request "$CAPTURED_RESPONSE_HTML" "$CAPTURED_REQUEST_ID" "$CAPTURED_HEADERS_FILE" "$CAPTURED_META_FILE"

CAPTURED_PROVIDER=''
CAPTURED_TARGET_URL=''
CAPTURED_PROXIED_PATH=''
CAPTURED_ATTEMPT_NO=''
CAPTURED_STREAM=''
CAPTURED_BODY_BYTES=''
while IFS='=' read -r key value; do
  case "$key" in
    captured_provider) CAPTURED_PROVIDER="$value" ;;
    captured_target_url) CAPTURED_TARGET_URL="$value" ;;
    captured_proxied_path) CAPTURED_PROXIED_PATH="$value" ;;
    captured_attempt_no) CAPTURED_ATTEMPT_NO="$value" ;;
    captured_stream) CAPTURED_STREAM="$value" ;;
    captured_body_bytes) CAPTURED_BODY_BYTES="$value" ;;
  esac
done <"$CAPTURED_META_FILE"

CAPTURED_PROVIDER_NORMALIZED="$(printf '%s' "$CAPTURED_PROVIDER" | tr '[:upper:]' '[:lower:]')"
if [[ "$CAPTURED_PROVIDER_NORMALIZED" != 'anthropic' ]]; then
  echo "error: captured Innies lane resolved to ${CAPTURED_PROVIDER:-unknown}; expected anthropic" >&2
  exit 1
fi

if [[ -n "$CAPTURED_BODY_BYTES" && "$CAPTURED_BODY_BYTES" != "$PAYLOAD_BYTES" ]]; then
  echo "error: payload bytes ($PAYLOAD_BYTES) do not match captured body bytes ($CAPTURED_BODY_BYTES)" >&2
  exit 1
fi

DIRECT_PATH="${CAPTURED_PROXIED_PATH:-/v1/messages}"
declare -a DIRECT_CURL_ARGS
DIRECT_CURL_ARGS=(
  -sS
  -D "$DIRECT_HEADERS_FILE"
  -o "$DIRECT_BODY_FILE"
  -w '%{http_code}'
  -X POST "${DIRECT_BASE_URL}${DIRECT_PATH}"
  --data-binary "@$PAYLOAD_PATH"
  -H "Authorization: Bearer $ACCESS_TOKEN"
)

HAVE_DIRECT_REQUEST_ID='false'
while IFS=$'\t' read -r header_name header_value; do
  [[ -z "$header_name" ]] && continue
  header_name_normalized="$(printf '%s' "$header_name" | tr '[:upper:]' '[:lower:]')"
  case "$header_name_normalized" in
    authorization|content-length|host)
      continue
      ;;
    x-request-id)
      DIRECT_CURL_ARGS+=(-H "x-request-id: $DIRECT_REQUEST_ID")
      HAVE_DIRECT_REQUEST_ID='true'
      ;;
    *)
      DIRECT_CURL_ARGS+=(-H "${header_name}: ${header_value}")
      ;;
  esac
done <"$CAPTURED_HEADERS_FILE"

if [[ "$HAVE_DIRECT_REQUEST_ID" != 'true' ]]; then
  DIRECT_CURL_ARGS+=(-H "x-request-id: $DIRECT_REQUEST_ID")
fi

DIRECT_STATUS="$(curl "${DIRECT_CURL_ARGS[@]}")"
PROVIDER_REQUEST_ID="$(extract_header 'request-id' "$DIRECT_HEADERS_FILE")"
if [[ -z "$PROVIDER_REQUEST_ID" ]]; then
  PROVIDER_REQUEST_ID="$(extract_body_request_id "$DIRECT_BODY_FILE")"
fi

OUTCOME='request_failed_otherwise'
if [[ "$DIRECT_STATUS" =~ ^2 ]]; then
  OUTCOME='request_succeeded'
elif [[ "$DIRECT_STATUS" == '400' ]] && grep -q '"type":"invalid_request_error"' "$DIRECT_BODY_FILE"; then
  OUTCOME='reproduced_invalid_request_error'
fi

META_LINES=(
  "payload_path=$PAYLOAD_PATH"
  "payload_bytes=$PAYLOAD_BYTES"
  "captured_response_html=$CAPTURED_RESPONSE_HTML"
  "captured_request_id=$CAPTURED_REQUEST_ID"
  "captured_provider=${CAPTURED_PROVIDER:-}"
  "captured_target_url=${CAPTURED_TARGET_URL:-}"
  "captured_proxied_path=${CAPTURED_PROXIED_PATH:-}"
  "captured_attempt_no=${CAPTURED_ATTEMPT_NO:-}"
  "captured_stream=${CAPTURED_STREAM:-}"
  "captured_body_bytes=${CAPTURED_BODY_BYTES:-}"
  "direct_request_id=$DIRECT_REQUEST_ID"
  "direct_status=$DIRECT_STATUS"
  "provider_request_id=${PROVIDER_REQUEST_ID:-}"
  "outcome=$OUTCOME"
  "direct_base_url=$DIRECT_BASE_URL"
  "direct_path=$DIRECT_PATH"
  "captured_headers_file=$CAPTURED_HEADERS_FILE"
  "captured_meta_file=$CAPTURED_META_FILE"
  "direct_headers_file=$DIRECT_HEADERS_FILE"
  "direct_body_file=$DIRECT_BODY_FILE"
)

write_lines "$META_FILE" "${META_LINES[@]}"
printf '%s\n' "${META_LINES[@]}"
echo "meta_file=$META_FILE"
