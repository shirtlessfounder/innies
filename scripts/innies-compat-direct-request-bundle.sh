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

resolve_access_token() {
  if [[ -n "${ANTHROPIC_OAUTH_ACCESS_TOKEN:-}" ]]; then
    printf '%s\t%s' "${ANTHROPIC_OAUTH_ACCESS_TOKEN}" 'anthropic_oauth_access_token'
    return
  fi
  if [[ -n "${ANTHROPIC_ACCESS_TOKEN:-}" ]]; then
    printf '%s\t%s' "${ANTHROPIC_ACCESS_TOKEN}" 'anthropic_access_token'
    return
  fi
  if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
    printf '%s\t%s' "${CLAUDE_CODE_OAUTH_TOKEN}" 'claude_code_oauth_token'
    return
  fi
  echo 'error: missing Anthropic OAuth access token (set ANTHROPIC_OAUTH_ACCESS_TOKEN, ANTHROPIC_ACCESS_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN)' >&2
  exit 1
}

extract_header_value() {
  local name="$1"
  local file="$2"
  awk -F'\t' -v target="$name" '
    BEGIN { IGNORECASE = 1 }
    tolower($1) == tolower(target) {
      print $2
    }
  ' "$file" | tail -1
}

extract_response_header() {
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

write_summary() {
  local file="$1"
  shift
  printf '%s\n' "$@" >"$file"
}

PAYLOAD_PATH="${1:-${INNIES_DIRECT_PAYLOAD_PATH:-}}"
HEADERS_TSV_PATH="${2:-${INNIES_DIRECT_HEADERS_TSV:-}}"
require_nonempty 'payload path' "$PAYLOAD_PATH"
require_nonempty 'headers tsv path' "$HEADERS_TSV_PATH"

if [[ ! -f "$PAYLOAD_PATH" ]]; then
  echo "error: payload file not found: $PAYLOAD_PATH" >&2
  exit 1
fi

if [[ ! -f "$HEADERS_TSV_PATH" ]]; then
  echo "error: headers TSV file not found: $HEADERS_TSV_PATH" >&2
  exit 1
fi

DIRECT_BASE_URL="$(resolve_direct_base_url)"
DIRECT_PATH="${INNIES_DIRECT_PATH:-/v1/messages}"
TARGET_URL="${DIRECT_BASE_URL}${DIRECT_PATH}"

TOKEN_AND_SOURCE="$(resolve_access_token)"
ACCESS_TOKEN="${TOKEN_AND_SOURCE%%$'\t'*}"
DIRECT_ACCESS_TOKEN_SOURCE="${TOKEN_AND_SOURCE#*$'\t'}"

DIRECT_REQUEST_ID="${INNIES_DIRECT_REQUEST_ID:-req_issue80_direct_$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="${INNIES_DIRECT_BUNDLE_OUT_DIR:-${TMPDIR:-/tmp}/innies-compat-direct-request-bundle-${DIRECT_REQUEST_ID}}"
mkdir -p "$OUT_DIR"

REQUEST_HEADERS_TSV="$OUT_DIR/request-headers.tsv"
RESPONSE_HEADERS_FILE="$OUT_DIR/response-headers.txt"
RESPONSE_BODY_FILE="$OUT_DIR/response-body.txt"
PAYLOAD_BYTES="$(wc -c <"$PAYLOAD_PATH" | tr -d '[:space:]')"
PAYLOAD_SHA256="$(openssl dgst -sha256 -r "$PAYLOAD_PATH" | awk '{print $1}')"

declare -a DIRECT_CURL_ARGS
DIRECT_CURL_ARGS=(
  -sS
  -D "$RESPONSE_HEADERS_FILE"
  -o "$RESPONSE_BODY_FILE"
  -w '%{http_code}'
  -X POST "$TARGET_URL"
  --data-binary "@$PAYLOAD_PATH"
)

printf 'authorization\tBearer <redacted>\n' >"$REQUEST_HEADERS_TSV"
have_request_id='false'
while IFS=$'\t' read -r header_name header_value; do
  [[ -z "$header_name" ]] && continue
  header_name="$(trim "$header_name")"
  header_value="$(trim "${header_value:-}")"
  [[ -z "$header_name" ]] && continue

  header_name_normalized="$(printf '%s' "$header_name" | tr '[:upper:]' '[:lower:]')"
  case "$header_name_normalized" in
    authorization|content-length|host)
      continue
      ;;
    x-request-id)
      header_value="$DIRECT_REQUEST_ID"
      have_request_id='true'
      ;;
  esac

  DIRECT_CURL_ARGS+=(-H "${header_name_normalized}: ${header_value}")
  printf '%s\t%s\n' "$header_name_normalized" "$header_value" >>"$REQUEST_HEADERS_TSV"
done <"$HEADERS_TSV_PATH"

if [[ "$have_request_id" != 'true' ]]; then
  DIRECT_CURL_ARGS+=(-H "x-request-id: $DIRECT_REQUEST_ID")
  printf 'x-request-id\t%s\n' "$DIRECT_REQUEST_ID" >>"$REQUEST_HEADERS_TSV"
fi

DIRECT_CURL_ARGS+=(-H "authorization: Bearer $ACCESS_TOKEN")
DIRECT_STATUS="$(curl "${DIRECT_CURL_ARGS[@]}")"
PROVIDER_REQUEST_ID="$(extract_response_header 'request-id' "$RESPONSE_HEADERS_FILE")"
if [[ -z "$PROVIDER_REQUEST_ID" ]]; then
  PROVIDER_REQUEST_ID="$(extract_body_request_id "$RESPONSE_BODY_FILE")"
fi

node - "$PAYLOAD_PATH" "$REQUEST_HEADERS_TSV" "$RESPONSE_HEADERS_FILE" "$RESPONSE_BODY_FILE" "$OUT_DIR" "$DIRECT_REQUEST_ID" "$TARGET_URL" "$PAYLOAD_BYTES" "$PAYLOAD_SHA256" "$DIRECT_STATUS" "$PROVIDER_REQUEST_ID" <<'NODE'
const fs = require('fs');
const path = require('path');

const [
  payloadPath,
  requestHeadersTsvPath,
  responseHeadersPath,
  responseBodyPath,
  outDir,
  requestId,
  targetUrl,
  payloadBytes,
  payloadSha256,
  directStatus,
  providerRequestId
] = process.argv.slice(2);

function readHeadersTsv(filePath) {
  const headers = {};
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split('\t');
    const name = String(parts[0] ?? '').trim().toLowerCase();
    const value = String(parts.slice(1).join('\t') ?? '').trim();
    if (!name) continue;
    headers[name] = value;
  }
  return headers;
}

function readResponseHeaders(filePath) {
  const headers = {};
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line || !line.includes(':')) continue;
    const index = line.indexOf(':');
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (!name) continue;
    headers[name] = value;
  }
  return headers;
}

const payloadText = fs.readFileSync(payloadPath, 'utf8');
const payload = JSON.parse(payloadText);
const requestHeaders = readHeadersTsv(requestHeadersTsvPath);
const responseHeaders = readResponseHeaders(responseHeadersPath);
const responseBodyText = fs.readFileSync(responseBodyPath, 'utf8');

let responseBodyJson = null;
try {
  responseBodyJson = JSON.parse(responseBodyText);
} catch {}

const requestRecord = {
  provider: 'anthropic',
  request_id: requestId,
  method: 'POST',
  target_url: targetUrl,
  headers: requestHeaders,
  body_bytes: Number(payloadBytes),
  body_sha256: payloadSha256,
  stream: Boolean(payload.stream)
};

const responseRecord = {
  request_id: requestId,
  status: Number(directStatus),
  provider_request_id: providerRequestId,
  headers: responseHeaders,
  body_json: responseBodyJson,
  body_text: responseBodyText
};

fs.writeFileSync(path.join(outDir, 'payload.json'), `${JSON.stringify(payload, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'direct-request.json'), `${JSON.stringify(requestRecord, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'upstream-request.json'), `${JSON.stringify(requestRecord, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'direct-response.json'), `${JSON.stringify(responseRecord, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'upstream-response.json'), `${JSON.stringify(responseRecord, null, 2)}\n`);
NODE

SUMMARY_FILE="$OUT_DIR/summary.txt"
SUMMARY_LINES=(
  "request_id=$DIRECT_REQUEST_ID"
  "target_url=$TARGET_URL"
  "body_bytes=$PAYLOAD_BYTES"
  "body_sha256=$PAYLOAD_SHA256"
  "direct_status=$DIRECT_STATUS"
  "provider_request_id=${PROVIDER_REQUEST_ID:-}"
  "direct_access_token_source=$DIRECT_ACCESS_TOKEN_SOURCE"
  "anthropic_beta=$(extract_header_value 'anthropic-beta' "$REQUEST_HEADERS_TSV")"
  "anthropic_version=$(extract_header_value 'anthropic-version' "$REQUEST_HEADERS_TSV")"
  "user_agent=$(extract_header_value 'user-agent' "$REQUEST_HEADERS_TSV")"
  "x_app=$(extract_header_value 'x-app' "$REQUEST_HEADERS_TSV")"
  "request_headers_tsv=$REQUEST_HEADERS_TSV"
  "response_headers_file=$RESPONSE_HEADERS_FILE"
  "response_body_file=$RESPONSE_BODY_FILE"
)
write_summary "$SUMMARY_FILE" "${SUMMARY_LINES[@]}"
printf '%s\n' "${SUMMARY_LINES[@]}"
echo "summary_file=$SUMMARY_FILE"
