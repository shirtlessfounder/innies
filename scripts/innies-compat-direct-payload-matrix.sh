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

write_lines() {
  local file="$1"
  shift
  printf '%s\n' "$@" >"$file"
}

PAYLOADS_TSV_PATH="${1:-${INNIES_DIRECT_PAYLOAD_MATRIX_TSV:-}}"
HEADERS_TSV_PATH="${2:-${INNIES_DIRECT_HEADERS_TSV:-}}"
require_nonempty 'payload matrix tsv path' "$PAYLOADS_TSV_PATH"
require_nonempty 'headers tsv path' "$HEADERS_TSV_PATH"

if [[ ! -f "$PAYLOADS_TSV_PATH" ]]; then
  echo "error: payload matrix TSV file not found: $PAYLOADS_TSV_PATH" >&2
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
REQUEST_ID_PREFIX="${INNIES_DIRECT_PAYLOAD_MATRIX_REQUEST_ID_PREFIX:-req_issue80_payload_matrix_$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="${INNIES_DIRECT_PAYLOAD_MATRIX_OUT_DIR:-${TMPDIR:-/tmp}/innies-compat-direct-payload-matrix-${REQUEST_ID_PREFIX}}"
PAYLOAD_OUT_DIR="$OUT_DIR/payloads"
SUMMARY_FILE="$OUT_DIR/summary.txt"
mkdir -p "$PAYLOAD_OUT_DIR"

SUMMARY_LINES=(
  "target_url=$TARGET_URL"
  "payload_matrix_tsv=$PAYLOADS_TSV_PATH"
  "headers_tsv_path=$HEADERS_TSV_PATH"
  "direct_access_token_source=$DIRECT_ACCESS_TOKEN_SOURCE"
)
write_lines "$SUMMARY_FILE" "${SUMMARY_LINES[@]}"

run_payload() {
  local payload_name="$1"
  local payload_path="$2"
  local request_id="${REQUEST_ID_PREFIX}_${payload_name}"
  local payload_dir="$PAYLOAD_OUT_DIR/$payload_name"
  local request_headers_tsv="$payload_dir/request-headers.tsv"
  local response_headers_file="$payload_dir/response-headers.txt"
  local response_body_file="$payload_dir/response-body.txt"
  local meta_file="$payload_dir/meta.txt"
  local payload_copy="$payload_dir/payload.json"

  if [[ ! -f "$payload_path" ]]; then
    echo "error: payload file not found for '$payload_name': $payload_path" >&2
    exit 1
  fi

  mkdir -p "$payload_dir"
  cp "$payload_path" "$payload_copy"

  local payload_bytes
  local payload_sha256
  payload_bytes="$(wc -c <"$payload_path" | tr -d '[:space:]')"
  payload_sha256="$(openssl dgst -sha256 -r "$payload_path" | awk '{print $1}')"

  declare -a curl_args
  curl_args=(
    -sS
    -D "$response_headers_file"
    -o "$response_body_file"
    -w '%{http_code}'
    -X POST "$TARGET_URL"
    --data-binary "@$payload_path"
  )

  printf 'authorization\tBearer <redacted>\n' >"$request_headers_tsv"
  local have_request_id='false'
  while IFS=$'\t' read -r raw_header_name raw_header_value; do
    [[ -z "${raw_header_name:-}" ]] && continue
    local header_name
    local header_value
    local normalized_name
    header_name="$(trim "$raw_header_name")"
    header_value="$(trim "${raw_header_value:-}")"
    [[ -z "$header_name" ]] && continue
    normalized_name="$(printf '%s' "$header_name" | tr '[:upper:]' '[:lower:]')"
    case "$normalized_name" in
      authorization|content-length|host|:*)
        continue
        ;;
      x-request-id)
        header_value="$request_id"
        have_request_id='true'
        ;;
    esac

    curl_args+=(-H "${normalized_name}: ${header_value}")
    printf '%s\t%s\n' "$normalized_name" "$header_value" >>"$request_headers_tsv"
  done <"$HEADERS_TSV_PATH"

  if [[ "$have_request_id" != 'true' ]]; then
    curl_args+=(-H "x-request-id: $request_id")
    printf 'x-request-id\t%s\n' "$request_id" >>"$request_headers_tsv"
  fi

  curl_args+=(-H "authorization: Bearer $ACCESS_TOKEN")

  local status
  status="$(curl "${curl_args[@]}")"
  local provider_request_id
  provider_request_id="$(extract_response_header 'request-id' "$response_headers_file")"
  if [[ -z "$provider_request_id" ]]; then
    provider_request_id="$(extract_body_request_id "$response_body_file")"
  fi

  local outcome='unexpected_http_status'
  if [[ "$status" =~ ^2 ]]; then
    outcome='request_succeeded'
  elif [[ "$status" == '400' ]] && grep -q '"type":"invalid_request_error"' "$response_body_file"; then
    outcome='reproduced_invalid_request_error'
  fi

  local meta_lines=(
    "payload=$payload_name"
    "status=$status"
    "outcome=$outcome"
    "request_id=$request_id"
    "provider_request_id=${provider_request_id:-}"
    "token_source=$DIRECT_ACCESS_TOKEN_SOURCE"
    "target_url=$TARGET_URL"
    "payload_path=$payload_path"
    "payload_copy=$payload_copy"
    "payload_bytes=$payload_bytes"
    "payload_sha256=$payload_sha256"
    "headers_tsv_path=$HEADERS_TSV_PATH"
    "request_headers_tsv=$request_headers_tsv"
    "response_headers_file=$response_headers_file"
    "response_body_file=$response_body_file"
  )
  write_lines "$meta_file" "${meta_lines[@]}"
  printf 'payload=%s status=%s provider_request_id=%s request_id=%s token_source=%s payload_sha256=%s payload_bytes=%s\n' \
    "$payload_name" \
    "$status" \
    "${provider_request_id:-}" \
    "$request_id" \
    "$DIRECT_ACCESS_TOKEN_SOURCE" \
    "$payload_sha256" \
    "$payload_bytes" >>"$SUMMARY_FILE"
}

payload_count=0
while IFS=$'\t' read -r raw_payload_name raw_payload_path _; do
  payload_name="$(trim "${raw_payload_name:-}")"
  payload_path="$(trim "${raw_payload_path:-}")"
  [[ -z "$payload_name" ]] && continue
  [[ "$payload_name" == \#* ]] && continue
  require_nonempty "payload path for '$payload_name'" "$payload_path"
  if [[ ! "$payload_name" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "error: invalid payload name '$payload_name' (use letters, numbers, dot, underscore, or dash)" >&2
    exit 1
  fi
  run_payload "$payload_name" "$payload_path"
  payload_count=$((payload_count + 1))
done <"$PAYLOADS_TSV_PATH"

if [[ "$payload_count" -eq 0 ]]; then
  echo "error: no payload entries found in $PAYLOADS_TSV_PATH" >&2
  exit 1
fi

printf 'payload_count=%s\n' "$payload_count" >>"$SUMMARY_FILE"
cat "$SUMMARY_FILE"
printf 'summary_file=%s\n' "$SUMMARY_FILE"
