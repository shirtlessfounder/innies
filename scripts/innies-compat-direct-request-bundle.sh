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

usage() {
  cat >&2 <<'EOF'
usage: scripts/innies-compat-direct-request-bundle.sh <payload.json>

Replays a captured Anthropic first pass directly and emits normalized captured/direct request bundles.

Required env:
- INNIES_CAPTURED_RESPONSE_HTML
- INNIES_CAPTURED_REQUEST_ID

Optional env:
- INNIES_DIRECT_BUNDLE_OUT_DIR
- INNIES_DIRECT_REQUEST_ID
- ANTHROPIC_DIRECT_BASE_URL
- ANTHROPIC_BASE_URL
- ANTHROPIC_OAUTH_ACCESS_TOKEN
- ANTHROPIC_ACCESS_TOKEN
- CLAUDE_CODE_OAUTH_TOKEN
EOF
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

DIRECT_ACCESS_TOKEN_SOURCE=''
ACCESS_TOKEN=''

resolve_direct_access_token() {
  if [[ -n "${ANTHROPIC_OAUTH_ACCESS_TOKEN:-}" ]]; then
    DIRECT_ACCESS_TOKEN_SOURCE='anthropic_oauth_access_token'
    ACCESS_TOKEN="${ANTHROPIC_OAUTH_ACCESS_TOKEN}"
    return
  fi
  if [[ -n "${ANTHROPIC_ACCESS_TOKEN:-}" ]]; then
    DIRECT_ACCESS_TOKEN_SOURCE='anthropic_access_token'
    ACCESS_TOKEN="${ANTHROPIC_ACCESS_TOKEN}"
    return
  fi
  if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
    DIRECT_ACCESS_TOKEN_SOURCE='claude_code_oauth_token'
    ACCESS_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN}"
    return
  fi
  DIRECT_ACCESS_TOKEN_SOURCE=''
  ACCESS_TOKEN=''
}

PAYLOAD_PATH="${1:-${INNIES_REPLAY_PAYLOAD_PATH:-}}"
if [[ $# -gt 1 ]]; then
  usage
  exit 1
fi
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
resolve_direct_access_token
require_nonempty 'Anthropic OAuth access token' "$ACCESS_TOKEN"

DIRECT_REQUEST_ID="${INNIES_DIRECT_REQUEST_ID:-req_issue80_direct_$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="${INNIES_DIRECT_BUNDLE_OUT_DIR:-${TMPDIR:-/tmp}/innies-compat-direct-request-bundle-${DIRECT_REQUEST_ID}}"
mkdir -p "$OUT_DIR"

CAPTURED_HEADERS_FILE="$OUT_DIR/captured-headers.tsv"
CAPTURED_META_FILE="$OUT_DIR/captured-meta.txt"
CAPTURED_REQUEST_JSON="$OUT_DIR/captured-upstream-request.json"
DIRECT_HEADERS_FILE="$OUT_DIR/direct-headers.txt"
DIRECT_BODY_FILE="$OUT_DIR/direct-body.txt"
META_FILE="$OUT_DIR/meta.txt"

node "${SCRIPT_DIR}/innies-compat-direct-request-bundle.mjs" \
  extract-captured \
  "$CAPTURED_RESPONSE_HTML" \
  "$CAPTURED_REQUEST_ID" \
  "$OUT_DIR"

CAPTURED_PROVIDER=''
CAPTURED_TARGET_URL=''
CAPTURED_PROXIED_PATH=''
CAPTURED_ATTEMPT_NO=''
CAPTURED_STREAM=''
CAPTURED_BODY_BYTES=''
CAPTURED_BODY_SHA256=''
while IFS='=' read -r key value; do
  case "$key" in
    captured_provider) CAPTURED_PROVIDER="$value" ;;
    captured_target_url) CAPTURED_TARGET_URL="$value" ;;
    captured_proxied_path) CAPTURED_PROXIED_PATH="$value" ;;
    captured_attempt_no) CAPTURED_ATTEMPT_NO="$value" ;;
    captured_stream) CAPTURED_STREAM="$value" ;;
    captured_body_bytes) CAPTURED_BODY_BYTES="$value" ;;
    captured_body_sha256) CAPTURED_BODY_SHA256="$value" ;;
  esac
done <"$CAPTURED_META_FILE"

CAPTURED_PROVIDER_NORMALIZED="$(printf '%s' "$CAPTURED_PROVIDER" | tr '[:upper:]' '[:lower:]')"
if [[ "$CAPTURED_PROVIDER_NORMALIZED" != 'anthropic' ]]; then
  echo "error: captured Innies lane resolved to ${CAPTURED_PROVIDER:-unknown}; expected anthropic" >&2
  exit 1
fi

DIRECT_PATH="${CAPTURED_PROXIED_PATH:-/v1/messages}"
DIRECT_TARGET_URL="${DIRECT_BASE_URL}${DIRECT_PATH}"
DIRECT_STATUS=''
declare -a DIRECT_CURL_ARGS
DIRECT_CURL_ARGS=(
  -sS
  -D "$DIRECT_HEADERS_FILE"
  -o "$DIRECT_BODY_FILE"
  -w '%{http_code}'
  -X POST "$DIRECT_TARGET_URL"
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

node "${SCRIPT_DIR}/innies-compat-direct-request-bundle.mjs" \
  write-direct-bundle \
  "$CAPTURED_REQUEST_JSON" \
  "$PAYLOAD_PATH" \
  "$DIRECT_TARGET_URL" \
  "$DIRECT_REQUEST_ID" \
  "$DIRECT_HEADERS_FILE" \
  "$DIRECT_BODY_FILE" \
  "$DIRECT_STATUS" \
  "$PROVIDER_REQUEST_ID" \
  "$OUT_DIR"

write_lines "$META_FILE" \
  "payload_path=$PAYLOAD_PATH" \
  "captured_response_html=$CAPTURED_RESPONSE_HTML" \
  "captured_request_id=$CAPTURED_REQUEST_ID" \
  "captured_provider=${CAPTURED_PROVIDER:-}" \
  "captured_target_url=${CAPTURED_TARGET_URL:-}" \
  "captured_proxied_path=${CAPTURED_PROXIED_PATH:-}" \
  "captured_attempt_no=${CAPTURED_ATTEMPT_NO:-}" \
  "captured_stream=${CAPTURED_STREAM:-}" \
  "captured_body_bytes=${CAPTURED_BODY_BYTES:-}" \
  "captured_body_sha256=${CAPTURED_BODY_SHA256:-}" \
  "direct_request_id=$DIRECT_REQUEST_ID" \
  "direct_status=$DIRECT_STATUS" \
  "provider_request_id=${PROVIDER_REQUEST_ID:-}" \
  "direct_access_token_source=${DIRECT_ACCESS_TOKEN_SOURCE:-}" \
  "direct_base_url=$DIRECT_BASE_URL" \
  "direct_target_url=$DIRECT_TARGET_URL" \
  "captured_headers_file=$CAPTURED_HEADERS_FILE" \
  "captured_meta_file=$CAPTURED_META_FILE" \
  "captured_request_json=$CAPTURED_REQUEST_JSON" \
  "direct_headers_file=$DIRECT_HEADERS_FILE" \
  "direct_body_file=$DIRECT_BODY_FILE" \
  "direct_request_json=$OUT_DIR/direct-request.json" \
  "direct_response_json=$OUT_DIR/direct-response.json"

cat "$META_FILE"
printf 'meta_file=%s\n' "$META_FILE"
