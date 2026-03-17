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

normalize_bool() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    ''|1|true|yes|on)
      printf 'true'
      ;;
    0|false|no|off)
      printf 'false'
      ;;
    *)
      echo "error: invalid boolean value: ${1:-}" >&2
      exit 1
      ;;
  esac
}

resolve_access_token() {
  if [[ -n "${ANTHROPIC_OAUTH_ACCESS_TOKEN:-}" ]]; then
    ACCESS_TOKEN="$ANTHROPIC_OAUTH_ACCESS_TOKEN"
    ACCESS_TOKEN_SOURCE='anthropic_oauth_access_token'
    return
  fi
  if [[ -n "${ANTHROPIC_ACCESS_TOKEN:-}" ]]; then
    ACCESS_TOKEN="$ANTHROPIC_ACCESS_TOKEN"
    ACCESS_TOKEN_SOURCE='anthropic_access_token'
    return
  fi
  if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
    ACCESS_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN"
    ACCESS_TOKEN_SOURCE='claude_code_oauth_token'
    return
  fi
  echo 'error: missing Anthropic OAuth access token' >&2
  exit 1
}

sha256_file() {
  openssl dgst -sha256 -r "$1" | awk '{print $1}'
}

PAYLOAD_PATH="${1:-${INNIES_REPLAY_PAYLOAD_PATH:-}}"
require_nonempty 'payload path' "$PAYLOAD_PATH"

if [[ ! -f "$PAYLOAD_PATH" ]]; then
  echo "error: payload file not found: $PAYLOAD_PATH" >&2
  exit 1
fi

resolve_access_token

DIRECT_BASE_URL="$(resolve_direct_base_url)"
DIRECT_PATH="${INNIES_DIRECT_PATH:-/v1/messages}"
TARGET_URL="${DIRECT_BASE_URL}${DIRECT_PATH}"
REQUEST_ID="${INNIES_DIRECT_REQUEST_ID:-req_issue80_direct_capture_$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="${INNIES_DIRECT_CAPTURE_OUT_DIR:-${TMPDIR:-/tmp}/innies-compat-direct-bundle-capture-${REQUEST_ID}}"
mkdir -p "$OUT_DIR"

ANTHROPIC_VERSION="${INNIES_DIRECT_ANTHROPIC_VERSION:-${INNIES_ANTHROPIC_VERSION:-2023-06-01}}"
ANTHROPIC_BETA="${INNIES_DIRECT_ANTHROPIC_BETA:-${INNIES_CALLER_ANTHROPIC_BETA:-fine-grained-tool-streaming-2025-05-14}}"
ACCEPT_HEADER="${INNIES_DIRECT_ACCEPT:-text/event-stream}"
INCLUDE_IDENTITY_HEADERS="$(normalize_bool "${INNIES_DIRECT_INCLUDE_IDENTITY_HEADERS:-true}")"
USER_AGENT="${INNIES_DIRECT_USER_AGENT:-OpenClawGateway/1.0}"
X_APP="${INNIES_DIRECT_X_APP:-cli}"

PAYLOAD_COPY_PATH="$OUT_DIR/payload.json"
UPSTREAM_REQUEST_PATH="$OUT_DIR/upstream-request.json"
UPSTREAM_RESPONSE_PATH="$OUT_DIR/upstream-response.json"
RESPONSE_HEADERS_PATH="$OUT_DIR/response-headers.txt"
RESPONSE_BODY_PATH="$OUT_DIR/response-body.txt"
SUMMARY_PATH="$OUT_DIR/summary.txt"

cp "$PAYLOAD_PATH" "$PAYLOAD_COPY_PATH"
PAYLOAD_BYTES="$(wc -c <"$PAYLOAD_PATH" | tr -d ' ')"
PAYLOAD_SHA256="$(sha256_file "$PAYLOAD_PATH")"
EXPECTED_BODY_BYTES="${INNIES_DIRECT_EXPECTED_BODY_BYTES:-}"
EXPECTED_BODY_SHA256="${INNIES_DIRECT_EXPECTED_BODY_SHA256:-}"

if [[ -n "$EXPECTED_BODY_BYTES" && "$PAYLOAD_BYTES" != "$EXPECTED_BODY_BYTES" ]]; then
  echo "error: payload bytes ($PAYLOAD_BYTES) do not match expected body bytes ($EXPECTED_BODY_BYTES)" >&2
  exit 1
fi

if [[ -n "$EXPECTED_BODY_SHA256" && "$PAYLOAD_SHA256" != "$EXPECTED_BODY_SHA256" ]]; then
  echo "error: payload sha256 ($PAYLOAD_SHA256) does not match expected body sha256 ($EXPECTED_BODY_SHA256)" >&2
  exit 1
fi

declare -a CURL_ARGS
CURL_ARGS=(
  -sS
  -D "$RESPONSE_HEADERS_PATH"
  -o "$RESPONSE_BODY_PATH"
  -w '%{http_code}'
  -X POST "$TARGET_URL"
  -H "Authorization: Bearer $ACCESS_TOKEN"
  -H 'Content-Type: application/json'
  -H "Accept: $ACCEPT_HEADER"
  -H "anthropic-version: $ANTHROPIC_VERSION"
  -H "anthropic-beta: $ANTHROPIC_BETA"
  -H "x-request-id: $REQUEST_ID"
  --data-binary "@$PAYLOAD_PATH"
)

if [[ "$INCLUDE_IDENTITY_HEADERS" == 'true' ]]; then
  CURL_ARGS+=(
    -H 'anthropic-dangerous-direct-browser-access: true'
    -H "x-app: $X_APP"
    -H "user-agent: $USER_AGENT"
  )
else
  CURL_ARGS+=(-H 'user-agent:')
fi

DIRECT_STATUS="$(curl "${CURL_ARGS[@]}")"
PROVIDER_REQUEST_ID="$(extract_header 'request-id' "$RESPONSE_HEADERS_PATH")"
if [[ -z "$PROVIDER_REQUEST_ID" ]]; then
  PROVIDER_REQUEST_ID="$(extract_body_request_id "$RESPONSE_BODY_PATH")"
fi
RESPONSE_CONTENT_TYPE="$(extract_header 'content-type' "$RESPONSE_HEADERS_PATH")"
RESPONSE_SHA256="$(sha256_file "$RESPONSE_BODY_PATH")"

SUMMARY_USER_AGENT=''
SUMMARY_X_APP=''
if [[ "$INCLUDE_IDENTITY_HEADERS" == 'true' ]]; then
  SUMMARY_USER_AGENT="$USER_AGENT"
  SUMMARY_X_APP="$X_APP"
fi

REQUEST_ID="$REQUEST_ID" \
TARGET_URL="$TARGET_URL" \
PAYLOAD_BYTES="$PAYLOAD_BYTES" \
PAYLOAD_SHA256="$PAYLOAD_SHA256" \
ANTHROPIC_VERSION="$ANTHROPIC_VERSION" \
ANTHROPIC_BETA="$ANTHROPIC_BETA" \
ACCEPT_HEADER="$ACCEPT_HEADER" \
INCLUDE_IDENTITY_HEADERS="$INCLUDE_IDENTITY_HEADERS" \
USER_AGENT="$USER_AGENT" \
X_APP="$X_APP" \
UPSTREAM_REQUEST_PATH="$UPSTREAM_REQUEST_PATH" \
UPSTREAM_RESPONSE_PATH="$UPSTREAM_RESPONSE_PATH" \
RESPONSE_BODY_PATH="$RESPONSE_BODY_PATH" \
DIRECT_STATUS="$DIRECT_STATUS" \
PROVIDER_REQUEST_ID="$PROVIDER_REQUEST_ID" \
RESPONSE_CONTENT_TYPE="$RESPONSE_CONTENT_TYPE" \
node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

const requestHeaders = {
  accept: process.env.ACCEPT_HEADER,
  'anthropic-beta': process.env.ANTHROPIC_BETA,
  'anthropic-version': process.env.ANTHROPIC_VERSION,
  authorization: 'Bearer <redacted>',
  'content-type': 'application/json',
  'x-request-id': process.env.REQUEST_ID
};

if (process.env.INCLUDE_IDENTITY_HEADERS === 'true') {
  requestHeaders['anthropic-dangerous-direct-browser-access'] = 'true';
  requestHeaders['x-app'] = process.env.X_APP;
  requestHeaders['user-agent'] = process.env.USER_AGENT;
}

const responseBodyText = fs.readFileSync(process.env.RESPONSE_BODY_PATH, 'utf8');
let parsedBody = null;
let bodyPreview = null;
try {
  parsedBody = JSON.parse(responseBodyText);
} catch {
  bodyPreview = responseBodyText.slice(0, 1024);
}

const upstreamRequest = {
  attempt_no: 1,
  body_bytes: Number(process.env.PAYLOAD_BYTES),
  body_sha256: process.env.PAYLOAD_SHA256,
  headers: requestHeaders,
  method: 'POST',
  provider: 'anthropic',
  request_id: process.env.REQUEST_ID,
  target_url: process.env.TARGET_URL
};

const upstreamResponse = {
  attempt_no: 1,
  request_id: process.env.REQUEST_ID,
  upstream_status: Number(process.env.DIRECT_STATUS),
  provider_request_id: process.env.PROVIDER_REQUEST_ID,
  content_type: process.env.RESPONSE_CONTENT_TYPE,
  body_sha256: sha256(responseBodyText),
  parsed_body: parsedBody,
  body_preview: bodyPreview
};

fs.writeFileSync(process.env.UPSTREAM_REQUEST_PATH, `${JSON.stringify(upstreamRequest, null, 2)}\n`);
fs.writeFileSync(process.env.UPSTREAM_RESPONSE_PATH, `${JSON.stringify(upstreamResponse, null, 2)}\n`);
NODE

SUMMARY_LINES=(
  "request_id=$REQUEST_ID"
  'provider=anthropic'
  "target_url=$TARGET_URL"
  "body_bytes=$PAYLOAD_BYTES"
  "body_sha256=$PAYLOAD_SHA256"
  "upstream_status=$DIRECT_STATUS"
  "provider_request_id=${PROVIDER_REQUEST_ID:-}"
  "payload_available=true"
  "direct_access_token_source=$ACCESS_TOKEN_SOURCE"
  "upstream_anthropic_beta=$ANTHROPIC_BETA"
  "upstream_anthropic_version=$ANTHROPIC_VERSION"
  "upstream_accept=$ACCEPT_HEADER"
  "upstream_user_agent=$SUMMARY_USER_AGENT"
  "upstream_x_app=$SUMMARY_X_APP"
  "response_content_type=${RESPONSE_CONTENT_TYPE:-}"
  "response_body_sha256=$RESPONSE_SHA256"
  "payload_path=$PAYLOAD_COPY_PATH"
  "upstream_request_path=$UPSTREAM_REQUEST_PATH"
  "upstream_response_path=$UPSTREAM_RESPONSE_PATH"
  "response_headers_path=$RESPONSE_HEADERS_PATH"
  "response_body_path=$RESPONSE_BODY_PATH"
)

printf '%s\n' "${SUMMARY_LINES[@]}" >"$SUMMARY_PATH"
cat "$SUMMARY_PATH"
printf 'summary_file=%s\n' "$SUMMARY_PATH"
