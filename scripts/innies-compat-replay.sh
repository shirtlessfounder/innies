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

extract_upstream_request_id() {
  local file="$1"
  local value
  value="$(sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p' "$file" | head -n 1)"
  printf '%s' "$value"
}

write_meta() {
  local file="$1"
  shift
  printf '%s\n' "$@" >"$file"
}

PAYLOAD_PATH="${1:-${INNIES_REPLAY_PAYLOAD_PATH:-}}"
require_nonempty 'payload path' "$PAYLOAD_PATH"

if [[ ! -f "$PAYLOAD_PATH" ]]; then
  echo "error: payload file not found: $PAYLOAD_PATH" >&2
  exit 1
fi

API_URL="$(resolve_api_url)"
BUYER_TOKEN="${INNIES_BUYER_API_KEY:-${INNIES_TOKEN:-${BUYER_TOKEN:-}}}"

if [[ -z "$BUYER_TOKEN" ]]; then
  if ! BUYER_TOKEN="$(prompt_secret 'buyer API key (press Enter to cancel)')"; then
    exit 1
  fi
fi
require_nonempty 'buyer API key' "$BUYER_TOKEN"

ANTHROPIC_VERSION="${INNIES_ANTHROPIC_VERSION:-2023-06-01}"
ANTHROPIC_BETA="${INNIES_ANTHROPIC_BETA:-fine-grained-tool-streaming-2025-05-14}"
REQUEST_ID="${INNIES_REQUEST_ID:-req_issue80_replay_$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="${INNIES_REPLAY_OUT_DIR:-${TMPDIR:-/tmp}/innies-compat-replay-$REQUEST_ID}"
mkdir -p "$OUT_DIR"

HEADERS_FILE="$OUT_DIR/headers.txt"
BODY_FILE="$OUT_DIR/body.txt"
META_FILE="$OUT_DIR/meta.txt"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PAYLOAD_BYTES="$(wc -c <"$PAYLOAD_PATH" | tr -d ' ')"

STATUS="$(curl -sS -D "$HEADERS_FILE" -o "$BODY_FILE" -w '%{http_code}' \
  -X POST "${API_URL}/v1/messages" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -H "anthropic-version: $ANTHROPIC_VERSION" \
  -H "anthropic-beta: $ANTHROPIC_BETA" \
  -H "x-request-id: $REQUEST_ID" \
  --data-binary @"$PAYLOAD_PATH")"

TOKEN_CREDENTIAL_ID="$(extract_header 'x-innies-token-credential-id' "$HEADERS_FILE")"
ATTEMPT_NO="$(extract_header 'x-innies-attempt-no' "$HEADERS_FILE")"
RESPONSE_REQUEST_ID="$(extract_header 'x-request-id' "$HEADERS_FILE")"
UPSTREAM_REQUEST_ID="$(extract_header 'request-id' "$HEADERS_FILE")"
if [[ -z "$UPSTREAM_REQUEST_ID" ]]; then
  UPSTREAM_REQUEST_ID="$(extract_upstream_request_id "$BODY_FILE")"
fi

OUTCOME='completed'
EXIT_CODE=0
if [[ "$STATUS" == "400" ]] && grep -q '"type":"invalid_request_error"' "$BODY_FILE"; then
  OUTCOME='reproduced_invalid_request_error'
  EXIT_CODE=1
elif [[ "$STATUS" =~ ^2 ]]; then
  OUTCOME='request_succeeded'
else
  OUTCOME='unexpected_http_status'
  EXIT_CODE=1
fi

META_LINES=(
  "timestamp=$TIMESTAMP"
  "endpoint=${API_URL}/v1/messages"
  "payload_path=$PAYLOAD_PATH"
  "payload_bytes=$PAYLOAD_BYTES"
  "request_id=$REQUEST_ID"
  "response_request_id=${RESPONSE_REQUEST_ID:-}"
  "status=$STATUS"
  "token_credential_id=${TOKEN_CREDENTIAL_ID:-}"
  "attempt_no=${ATTEMPT_NO:-}"
  "upstream_request_id=${UPSTREAM_REQUEST_ID:-}"
  "outcome=$OUTCOME"
  "out_dir=$OUT_DIR"
  "headers_file=$HEADERS_FILE"
  "body_file=$BODY_FILE"
)

write_meta "$META_FILE" "${META_LINES[@]}"
printf '%s\n' "${META_LINES[@]}"
echo "meta_file=$META_FILE"

exit "$EXIT_CODE"
