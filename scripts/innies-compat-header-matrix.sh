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

PAYLOAD_PATH="${1:-${INNIES_REPLAY_PAYLOAD_PATH:-}}"
require_nonempty 'payload path' "$PAYLOAD_PATH"

if [[ ! -f "$PAYLOAD_PATH" ]]; then
  echo "error: payload file not found: $PAYLOAD_PATH" >&2
  exit 1
fi

DIRECT_BASE_URL="$(resolve_direct_base_url)"
ACCESS_TOKEN="${ANTHROPIC_OAUTH_ACCESS_TOKEN:-${ANTHROPIC_ACCESS_TOKEN:-}}"
require_nonempty 'Anthropic OAuth access token' "$ACCESS_TOKEN"

ANTHROPIC_VERSION="${INNIES_ANTHROPIC_VERSION:-2023-06-01}"
CALLER_BETA="${INNIES_CALLER_ANTHROPIC_BETA:-fine-grained-tool-streaming-2025-05-14}"
MERGED_BETA="${INNIES_CURRENT_MAIN_ANTHROPIC_BETA:-${CALLER_BETA},claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14}"
REQUEST_ID_PREFIX="${INNIES_MATRIX_REQUEST_ID_PREFIX:-req_issue80_matrix_$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="${INNIES_MATRIX_OUT_DIR:-${TMPDIR:-/tmp}/innies-compat-header-matrix-${REQUEST_ID_PREFIX}}"
mkdir -p "$OUT_DIR/cases"

SUMMARY_FILE="$OUT_DIR/summary.txt"
: >"$SUMMARY_FILE"

run_case() {
  local case_name="$1"
  local anthropic_beta="$2"
  local include_identity="$3"
  local case_dir="$OUT_DIR/cases/$case_name"
  local headers_file="$case_dir/headers.txt"
  local body_file="$case_dir/body.txt"
  local meta_file="$case_dir/meta.txt"
  local request_id="${REQUEST_ID_PREFIX}_${case_name}"
  local identity_label='disabled'
  mkdir -p "$case_dir"

  local curl_args=(
    -sS
    -D "$headers_file"
    -o "$body_file"
    -w '%{http_code}'
    -X POST "${DIRECT_BASE_URL}/v1/messages"
    -H "Authorization: Bearer $ACCESS_TOKEN"
    -H 'Content-Type: application/json'
    -H 'Accept: text/event-stream'
    -H "anthropic-version: $ANTHROPIC_VERSION"
    -H "anthropic-beta: $anthropic_beta"
    -H "x-request-id: $request_id"
    --data-binary "@$PAYLOAD_PATH"
  )

  if [[ "$include_identity" == 'true' ]]; then
    identity_label='enabled'
    curl_args+=(
      -H 'anthropic-dangerous-direct-browser-access: true'
      -H 'x-app: cli'
      -H 'user-agent: OpenClawGateway/1.0'
    )
  fi

  local status
  status="$(curl "${curl_args[@]}")"

  local provider_request_id
  provider_request_id="$(extract_header 'request-id' "$headers_file")"
  if [[ -z "$provider_request_id" ]]; then
    provider_request_id="$(extract_body_request_id "$body_file")"
  fi

  local outcome='unexpected_http_status'
  if [[ "$status" =~ ^2 ]]; then
    outcome='request_succeeded'
  elif [[ "$status" == '400' ]] && grep -q '"type":"invalid_request_error"' "$body_file"; then
    outcome='reproduced_invalid_request_error'
  fi

  local meta_lines=(
    "case=$case_name"
    "status=$status"
    "outcome=$outcome"
    "request_id=$request_id"
    "provider_request_id=${provider_request_id:-}"
    "anthropic_version=$ANTHROPIC_VERSION"
    "anthropic_beta=$anthropic_beta"
    "identity_headers=$identity_label"
    "endpoint=${DIRECT_BASE_URL}/v1/messages"
    "payload_path=$PAYLOAD_PATH"
    "headers_file=$headers_file"
    "body_file=$body_file"
  )

  write_lines "$meta_file" "${meta_lines[@]}"
  printf 'case=%s status=%s provider_request_id=%s anthropic_beta=%s identity_headers=%s\n' \
    "$case_name" \
    "$status" \
    "${provider_request_id:-}" \
    "$anthropic_beta" \
    "$identity_label" >>"$SUMMARY_FILE"
}

run_case 'current_main_first_pass' "$MERGED_BETA" 'true'
run_case 'merged_beta_without_identity' "$MERGED_BETA" 'false'
run_case 'caller_beta_only' "$CALLER_BETA" 'false'
run_case 'caller_beta_with_identity' "$CALLER_BETA" 'true'

cat "$SUMMARY_FILE"
printf 'summary_file=%s\n' "$SUMMARY_FILE"
