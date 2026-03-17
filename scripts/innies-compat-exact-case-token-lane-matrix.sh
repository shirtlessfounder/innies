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

resolve_token_spec() {
  local token_spec="$1"
  case "$token_spec" in
    env:*)
      local env_name="${token_spec#env:}"
      require_nonempty 'token env var name' "$env_name"
      local env_value="${!env_name:-}"
      if [[ -z "$env_value" ]]; then
        echo "error: missing token env var: $env_name" >&2
        exit 1
      fi
      printf '%s\t%s' "$env_value" "env:$env_name"
      ;;
    literal:*)
      local literal_value="${token_spec#literal:}"
      require_nonempty 'literal token value' "$literal_value"
      printf '%s\tliteral' "$literal_value"
      ;;
    *)
      echo "error: unsupported token source '$token_spec' (expected env:VAR_NAME or literal:TOKEN)" >&2
      exit 1
      ;;
  esac
}

PAYLOAD_PATH="${1:-${INNIES_EXACT_CASE_TOKEN_LANE_MATRIX_PAYLOAD_PATH:-}}"
CASES_DIR="${2:-${INNIES_EXACT_CASE_TOKEN_LANE_MATRIX_CASES_DIR:-}}"
TOKENS_TSV_PATH="${3:-${INNIES_EXACT_CASE_TOKEN_LANE_MATRIX_TOKENS_TSV:-}}"
require_nonempty 'payload path' "$PAYLOAD_PATH"
require_nonempty 'cases dir' "$CASES_DIR"
require_nonempty 'token matrix TSV path' "$TOKENS_TSV_PATH"

if [[ ! -f "$PAYLOAD_PATH" ]]; then
  echo "error: payload file not found: $PAYLOAD_PATH" >&2
  exit 1
fi

if [[ ! -d "$CASES_DIR" ]]; then
  echo "error: cases directory not found: $CASES_DIR" >&2
  exit 1
fi

if [[ ! -f "$TOKENS_TSV_PATH" ]]; then
  echo "error: token matrix TSV file not found: $TOKENS_TSV_PATH" >&2
  exit 1
fi

CASE_FILES=()
while IFS= read -r case_file; do
  CASE_FILES+=("$case_file")
done < <(find "$CASES_DIR" -maxdepth 1 -type f -name '*.tsv' | LC_ALL=C sort)

if [[ "${#CASE_FILES[@]}" -eq 0 ]]; then
  echo "error: no case TSV files found in $CASES_DIR" >&2
  exit 1
fi

DIRECT_BASE_URL="$(resolve_direct_base_url)"
DIRECT_PATH="${INNIES_DIRECT_PATH:-/v1/messages}"
TARGET_URL="${DIRECT_BASE_URL}${DIRECT_PATH}"
REQUEST_ID_PREFIX="${INNIES_EXACT_CASE_TOKEN_LANE_MATRIX_REQUEST_ID_PREFIX:-req_issue80_case_lane_$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="${INNIES_EXACT_CASE_TOKEN_LANE_MATRIX_OUT_DIR:-${TMPDIR:-/tmp}/innies-compat-exact-case-token-lane-matrix-${REQUEST_ID_PREFIX}}"
SUMMARY_FILE="$OUT_DIR/summary.txt"
mkdir -p "$OUT_DIR/lanes"

PAYLOAD_BYTES="$(wc -c <"$PAYLOAD_PATH" | tr -d '[:space:]')"
PAYLOAD_SHA256="$(openssl dgst -sha256 -r "$PAYLOAD_PATH" | awk '{print $1}')"

run_case_lane() {
  local lane_name="$1"
  local token_spec="$2"
  local case_file="$3"
  local token_value_and_source
  token_value_and_source="$(resolve_token_spec "$token_spec")"
  local access_token="${token_value_and_source%%$'\t'*}"
  local token_source="${token_value_and_source#*$'\t'}"
  local case_name
  case_name="$(basename "$case_file" .tsv)"
  local request_id="${REQUEST_ID_PREFIX}_${lane_name}_${case_name}"
  local case_dir="$OUT_DIR/lanes/$lane_name/cases/$case_name"
  local request_headers_tsv="$case_dir/request-headers.tsv"
  local response_headers_file="$case_dir/response-headers.txt"
  local response_body_file="$case_dir/response-body.txt"
  local meta_file="$case_dir/meta.txt"
  mkdir -p "$case_dir"

  declare -a curl_args
  curl_args=(
    -sS
    -D "$response_headers_file"
    -o "$response_body_file"
    -w '%{http_code}'
    -X POST "$TARGET_URL"
    --data-binary "@$PAYLOAD_PATH"
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
  done <"$case_file"

  if [[ "$have_request_id" != 'true' ]]; then
    curl_args+=(-H "x-request-id: $request_id")
    printf 'x-request-id\t%s\n' "$request_id" >>"$request_headers_tsv"
  fi

  curl_args+=(-H "authorization: Bearer $access_token")

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
    "lane=$lane_name"
    "case=$case_name"
    "status=$status"
    "outcome=$outcome"
    "request_id=$request_id"
    "provider_request_id=${provider_request_id:-}"
    "token_source=$token_source"
    "case_file=$case_file"
    "payload_path=$PAYLOAD_PATH"
    "target_url=$TARGET_URL"
    "request_headers_tsv=$request_headers_tsv"
    "response_headers_file=$response_headers_file"
    "response_body_file=$response_body_file"
  )
  write_lines "$meta_file" "${meta_lines[@]}"
  printf 'lane=%s case=%s status=%s outcome=%s provider_request_id=%s request_id=%s token_source=%s\n' \
    "$lane_name" \
    "$case_name" \
    "$status" \
    "$outcome" \
    "${provider_request_id:-}" \
    "$request_id" \
    "$token_source" >>"$SUMMARY_FILE"
}

lane_count=0
while IFS=$'\t' read -r raw_lane_name raw_token_spec _; do
  lane_name="$(trim "${raw_lane_name:-}")"
  token_spec="$(trim "${raw_token_spec:-}")"
  [[ -z "$lane_name" ]] && continue
  [[ "$lane_name" == \#* ]] && continue
  require_nonempty "token spec for lane '$lane_name'" "$token_spec"
  if [[ ! "$lane_name" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "error: invalid lane name '$lane_name' (use letters, numbers, dot, underscore, or dash)" >&2
    exit 1
  fi
  for case_file in "${CASE_FILES[@]}"; do
    run_case_lane "$lane_name" "$token_spec" "$case_file"
  done
  lane_count=$((lane_count + 1))
done <"$TOKENS_TSV_PATH"

if [[ "$lane_count" -eq 0 ]]; then
  echo "error: no token lanes found in $TOKENS_TSV_PATH" >&2
  exit 1
fi

SUMMARY_LINES=(
  "target_url=$TARGET_URL"
  "body_bytes=$PAYLOAD_BYTES"
  "body_sha256=$PAYLOAD_SHA256"
  "case_count=${#CASE_FILES[@]}"
  "lane_count=$lane_count"
  "cases_dir=$CASES_DIR"
  "token_matrix_tsv=$TOKENS_TSV_PATH"
)
{
  printf '%s\n' "${SUMMARY_LINES[@]}"
  cat "$SUMMARY_FILE"
} >"${SUMMARY_FILE}.tmp"
mv "${SUMMARY_FILE}.tmp" "$SUMMARY_FILE"

cat "$SUMMARY_FILE"
printf 'summary_file=%s\n' "$SUMMARY_FILE"
