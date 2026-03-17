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

resolve_case_files() {
  local source="$1"

  if [[ -f "$source" ]]; then
    if [[ "$source" != *.tsv ]]; then
      echo "error: case file must be a .tsv file: $source" >&2
      exit 1
    fi
    printf '%s\n' "$source"
    return
  fi

  if [[ -d "$source" ]]; then
    find "$source" -maxdepth 1 -type f -name '*.tsv' | sort
    return
  fi

  echo "error: case source path not found: $source" >&2
  exit 1
}

PAYLOAD_PATH="${1:-${INNIES_EXACT_CASE_MATRIX_PAYLOAD_PATH:-}}"
CASE_SOURCE="${2:-${INNIES_EXACT_CASE_MATRIX_CASE_SOURCE:-}}"
OUT_DIR="${3:-${INNIES_EXACT_CASE_MATRIX_OUT_DIR:-${TMPDIR:-/tmp}/innies-compat-exact-case-matrix-$(date -u +%Y%m%dT%H%M%SZ)}}"
require_nonempty 'payload path' "$PAYLOAD_PATH"
require_nonempty 'case source path' "$CASE_SOURCE"

if [[ ! -f "$PAYLOAD_PATH" ]]; then
  echo "error: payload file not found: $PAYLOAD_PATH" >&2
  exit 1
fi

CASE_FILES=()
while IFS= read -r case_file; do
  [[ -n "$case_file" ]] && CASE_FILES+=("$case_file")
done < <(resolve_case_files "$CASE_SOURCE")

if [[ "${#CASE_FILES[@]}" -eq 0 ]]; then
  echo "error: no case TSV files found: $CASE_SOURCE" >&2
  exit 1
fi

DIRECT_BASE_URL="$(resolve_direct_base_url)"
DIRECT_PATH="${INNIES_DIRECT_PATH:-/v1/messages}"
TARGET_URL="${DIRECT_BASE_URL}${DIRECT_PATH}"

TOKEN_AND_SOURCE="$(resolve_access_token)"
ACCESS_TOKEN="${TOKEN_AND_SOURCE%%$'\t'*}"
DIRECT_ACCESS_TOKEN_SOURCE="${TOKEN_AND_SOURCE#*$'\t'}"

mkdir -p "$OUT_DIR"
PAYLOAD_COPY_PATH="$OUT_DIR/payload.json"
cp "$PAYLOAD_PATH" "$PAYLOAD_COPY_PATH"

PAYLOAD_BYTES="$(wc -c <"$PAYLOAD_PATH" | tr -d '[:space:]')"
PAYLOAD_SHA256="$(openssl dgst -sha256 -r "$PAYLOAD_PATH" | awk '{print $1}')"
PAYLOAD_STREAM="$(node -e "const fs=require('fs'); try { const payload=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(String(Boolean(payload && payload.stream))); } catch { process.stdout.write(''); }" "$PAYLOAD_PATH")"

CASE_LINES=()
CASE_FILE_NAMES=()

for case_file in "${CASE_FILES[@]}"; do
  case_name="$(basename "$case_file" .tsv)"
  CASE_FILE_NAMES+=("$(basename "$case_file")")

  case_dir="$OUT_DIR/$case_name"
  mkdir -p "$case_dir"

  request_headers_tsv="$case_dir/request-headers.tsv"
  response_headers_file="$case_dir/response-headers.txt"
  response_body_file="$case_dir/response-body.txt"
  request_json_file="$case_dir/request.json"
  response_json_file="$case_dir/response.json"

  printf 'authorization\tBearer <redacted>\n' >"$request_headers_tsv"

  header_names='authorization'
  request_id_header=''
  anthropic_beta=''
  anthropic_version=''
  user_agent=''
  x_app=''
  dangerous_direct_browser_access=''

  curl_args=(
    -sS
    -D "$response_headers_file"
    -o "$response_body_file"
    -w '%{http_code}'
    -X POST "$TARGET_URL"
    --data-binary "@$PAYLOAD_PATH"
    -H "authorization: Bearer $ACCESS_TOKEN"
  )

  while IFS=$'\t' read -r raw_header_name raw_header_value; do
    [[ -z "$raw_header_name" ]] && continue
    header_name="$(trim "$raw_header_name")"
    header_value="$(trim "${raw_header_value:-}")"
    [[ -z "$header_name" ]] && continue

    header_name="$(printf '%s' "$header_name" | tr '[:upper:]' '[:lower:]')"
    case "$header_name" in
      authorization|content-length|host)
        continue
        ;;
    esac

    curl_args+=(-H "${header_name}: ${header_value}")
    printf '%s\t%s\n' "$header_name" "$header_value" >>"$request_headers_tsv"
    header_names="${header_names},${header_name}"

    case "$header_name" in
      x-request-id) request_id_header="$header_value" ;;
      anthropic-beta) anthropic_beta="$header_value" ;;
      anthropic-version) anthropic_version="$header_value" ;;
      user-agent) user_agent="$header_value" ;;
      x-app) x_app="$header_value" ;;
      anthropic-dangerous-direct-browser-access) dangerous_direct_browser_access="$header_value" ;;
    esac
  done <"$case_file"

  case_status="$(curl "${curl_args[@]}")"
  provider_request_id="$(extract_response_header 'request-id' "$response_headers_file")"
  if [[ -z "$provider_request_id" ]]; then
    provider_request_id="$(extract_body_request_id "$response_body_file")"
  fi

  node - "$request_headers_tsv" "$response_headers_file" "$response_body_file" "$request_json_file" "$response_json_file" "$TARGET_URL" "$request_id_header" "$PAYLOAD_BYTES" "$PAYLOAD_SHA256" "$PAYLOAD_STREAM" "$case_status" "$provider_request_id" <<'NODE'
const fs = require('fs');

const [
  requestHeadersTsvPath,
  responseHeadersPath,
  responseBodyPath,
  requestJsonPath,
  responseJsonPath,
  targetUrl,
  requestIdHeader,
  payloadBytes,
  payloadSha256,
  payloadStream,
  caseStatus,
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

const requestHeaders = readHeadersTsv(requestHeadersTsvPath);
const responseHeaders = readResponseHeaders(responseHeadersPath);
const responseBodyText = fs.readFileSync(responseBodyPath, 'utf8');

let responseBodyJson = null;
try {
  responseBodyJson = JSON.parse(responseBodyText);
} catch {}

const requestRecord = {
  provider: 'anthropic',
  request_id: requestIdHeader || '',
  method: 'POST',
  target_url: targetUrl,
  headers: requestHeaders,
  body_bytes: Number(payloadBytes),
  body_sha256: payloadSha256,
  stream: payloadStream === '' ? null : payloadStream === 'true'
};

const responseRecord = {
  request_id: requestIdHeader || '',
  status: Number(caseStatus),
  provider_request_id: providerRequestId || '',
  headers: responseHeaders,
  body_json: responseBodyJson,
  body_text: responseBodyText
};

fs.writeFileSync(requestJsonPath, `${JSON.stringify(requestRecord, null, 2)}\n`);
fs.writeFileSync(responseJsonPath, `${JSON.stringify(responseRecord, null, 2)}\n`);
NODE

  CASE_LINES+=("case=$case_name status=$case_status provider_request_id=${provider_request_id:-} request_id_header=${request_id_header:-} anthropic_beta=${anthropic_beta:-} anthropic_version=${anthropic_version:-} dangerous_direct_browser_access=${dangerous_direct_browser_access:-} user_agent=${user_agent:-} x_app=${x_app:-} header_names=$header_names case_dir=$case_dir")
done

SUMMARY_FILE="$OUT_DIR/summary.txt"
SUMMARY_LINES=(
  "payload_path=$PAYLOAD_PATH"
  "payload_copy_path=$PAYLOAD_COPY_PATH"
  "target_url=$TARGET_URL"
  "body_bytes=$PAYLOAD_BYTES"
  "body_sha256=$PAYLOAD_SHA256"
  "direct_access_token_source=$DIRECT_ACCESS_TOKEN_SOURCE"
  "case_count=${#CASE_LINES[@]}"
  "case_files=$(IFS=,; printf '%s' "${CASE_FILE_NAMES[*]}")"
)

write_lines "$SUMMARY_FILE" "${SUMMARY_LINES[@]}" "${CASE_LINES[@]}"
cat "$SUMMARY_FILE"
printf 'summary_file=%s\n' "$SUMMARY_FILE"
