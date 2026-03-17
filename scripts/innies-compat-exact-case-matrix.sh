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

write_lines() {
  local file="$1"
  shift
  printf '%s\n' "$@" >"$file"
}

PAYLOAD_PATH="${1:-${INNIES_EXACT_CASE_MATRIX_PAYLOAD_PATH:-}}"
CASES_DIR="${2:-${INNIES_EXACT_CASE_MATRIX_CASES_DIR:-}}"
require_nonempty 'payload path' "$PAYLOAD_PATH"
require_nonempty 'cases dir' "$CASES_DIR"

if [[ ! -f "$PAYLOAD_PATH" ]]; then
  echo "error: payload file not found: $PAYLOAD_PATH" >&2
  exit 1
fi

if [[ ! -d "$CASES_DIR" ]]; then
  echo "error: cases directory not found: $CASES_DIR" >&2
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
TOKEN_AND_SOURCE="$(resolve_access_token)"
ACCESS_TOKEN="${TOKEN_AND_SOURCE%%$'\t'*}"
DIRECT_ACCESS_TOKEN_SOURCE="${TOKEN_AND_SOURCE#*$'\t'}"

REQUEST_ID_PREFIX="${INNIES_EXACT_CASE_MATRIX_REQUEST_ID_PREFIX:-req_issue80_exact_case_$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="${INNIES_EXACT_CASE_MATRIX_OUT_DIR:-${TMPDIR:-/tmp}/innies-compat-exact-case-matrix-${REQUEST_ID_PREFIX}}"
mkdir -p "$OUT_DIR/cases"

PAYLOAD_BYTES="$(wc -c <"$PAYLOAD_PATH" | tr -d '[:space:]')"
PAYLOAD_SHA256="$(openssl dgst -sha256 -r "$PAYLOAD_PATH" | awk '{print $1}')"
SUMMARY_FILE="$OUT_DIR/summary.txt"
SUMMARY_LINES=(
  "target_url=$TARGET_URL"
  "body_bytes=$PAYLOAD_BYTES"
  "body_sha256=$PAYLOAD_SHA256"
  "case_count=${#CASE_FILES[@]}"
  "cases_dir=$CASES_DIR"
  "direct_access_token_source=$DIRECT_ACCESS_TOKEN_SOURCE"
)
write_lines "$SUMMARY_FILE" "${SUMMARY_LINES[@]}"

run_case() {
  local case_file="$1"
  local case_name
  case_name="$(basename "$case_file" .tsv)"
  local case_dir="$OUT_DIR/cases/$case_name"
  local request_headers_tsv="$case_dir/request-headers.tsv"
  local response_headers_file="$case_dir/response-headers.txt"
  local response_body_file="$case_dir/response-body.txt"
  local request_id="${REQUEST_ID_PREFIX}_${case_name}"

  mkdir -p "$case_dir"
  printf 'authorization\tBearer <redacted>\n' >"$request_headers_tsv"

  local -a curl_args
  curl_args=(
    -sS
    -D "$response_headers_file"
    -o "$response_body_file"
    -w '%{http_code}'
    -X POST "$TARGET_URL"
    --data-binary "@$PAYLOAD_PATH"
  )

  local have_request_id='false'
  while IFS=$'\t' read -r header_name header_value; do
    [[ -z "${header_name:-}" ]] && continue
    header_name="$(trim "$header_name")"
    header_value="$(trim "${header_value:-}")"
    [[ -z "$header_name" ]] && continue

    local header_name_normalized
    header_name_normalized="$(printf '%s' "$header_name" | tr '[:upper:]' '[:lower:]')"
    case "$header_name_normalized" in
      authorization|content-length|host|:*)
        continue
        ;;
      x-request-id)
        header_value="$request_id"
        have_request_id='true'
        ;;
    esac

    curl_args+=(-H "${header_name_normalized}: ${header_value}")
    printf '%s\t%s\n' "$header_name_normalized" "$header_value" >>"$request_headers_tsv"
  done <"$case_file"

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
  if [[ "$status" == 2* ]]; then
    outcome='request_succeeded'
  elif [[ "$status" == '400' ]] && grep -q '"type":"invalid_request_error"' "$response_body_file"; then
    outcome='reproduced_invalid_request_error'
  fi

  node - "$PAYLOAD_PATH" "$request_headers_tsv" "$response_headers_file" "$response_body_file" "$case_dir" "$case_name" "$request_id" "$TARGET_URL" "$PAYLOAD_BYTES" "$PAYLOAD_SHA256" "$status" "$provider_request_id" <<'NODE'
const fs = require('fs');
const path = require('path');

const [
  payloadPath,
  requestHeadersTsvPath,
  responseHeadersPath,
  responseBodyPath,
  caseDir,
  caseName,
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
  case_name: caseName,
  request_id: requestId,
  method: 'POST',
  target_url: targetUrl,
  headers: requestHeaders,
  body_bytes: Number(payloadBytes),
  body_sha256: payloadSha256,
  stream: Boolean(payload.stream)
};

const responseRecord = {
  case_name: caseName,
  request_id: requestId,
  status: Number(directStatus),
  provider_request_id: providerRequestId,
  headers: responseHeaders,
  body_json: responseBodyJson,
  body_text: responseBodyText
};

fs.writeFileSync(path.join(caseDir, 'payload.json'), `${JSON.stringify(payload, null, 2)}\n`);
fs.writeFileSync(path.join(caseDir, 'direct-request.json'), `${JSON.stringify(requestRecord, null, 2)}\n`);
fs.writeFileSync(path.join(caseDir, 'upstream-request.json'), `${JSON.stringify(requestRecord, null, 2)}\n`);
fs.writeFileSync(path.join(caseDir, 'direct-response.json'), `${JSON.stringify(responseRecord, null, 2)}\n`);
fs.writeFileSync(path.join(caseDir, 'upstream-response.json'), `${JSON.stringify(responseRecord, null, 2)}\n`);
NODE

  local identity_headers='false'
  if [[ "$(extract_header_value 'anthropic-dangerous-direct-browser-access' "$request_headers_tsv")" == 'true' ]]; then
    identity_headers='true'
  fi

  local case_summary_file="$case_dir/summary.txt"
  local -a case_summary_lines
  case_summary_lines=(
    "case=$case_name"
    "status=$status"
    "outcome=$outcome"
    "request_id=$request_id"
    "provider_request_id=${provider_request_id:-}"
    "body_bytes=$PAYLOAD_BYTES"
    "body_sha256=$PAYLOAD_SHA256"
    "anthropic_beta=$(extract_header_value 'anthropic-beta' "$request_headers_tsv")"
    "identity_headers=$identity_headers"
    "request_headers_tsv=$request_headers_tsv"
    "response_headers_file=$response_headers_file"
    "response_body_file=$response_body_file"
  )
  write_lines "$case_summary_file" "${case_summary_lines[@]}"

  printf 'case=%s status=%s outcome=%s provider_request_id=%s anthropic_beta=%s identity_headers=%s\n' \
    "$case_name" \
    "$status" \
    "$outcome" \
    "${provider_request_id:-}" \
    "$(extract_header_value 'anthropic-beta' "$request_headers_tsv")" \
    "$identity_headers" >>"$SUMMARY_FILE"
}

for case_file in "${CASE_FILES[@]}"; do
  run_case "$case_file"
done

cat "$SUMMARY_FILE"
printf 'summary_file=%s\n' "$SUMMARY_FILE"
