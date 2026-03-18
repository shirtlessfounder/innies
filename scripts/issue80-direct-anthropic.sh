#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="${SCRIPT_DIR}/${SCRIPT_PATH}"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_common.sh"

usage() {
  cat >&2 <<'EOF'
usage: issue80-direct-anthropic.sh <body.json> [beta_mode]

beta_mode:
  caller_only
  caller_plus_oauth   (default; closest to working direct OpenClaw OAuth lane)
  oauth_only
  none
EOF
  exit 1
}

header_value() {
  local file="$1"
  local name="$2"
  awk -F': ' -v target="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')" '
    {
      key = tolower($1);
      gsub("\r", "", $2);
      if (key == target) value = $2;
    }
    END {
      if (value != "") print value;
    }
  ' "$file"
}

print_body() {
  local file="$1"
  local content_type="$2"
  if [[ "$content_type" == *application/json* ]] && command -v jq >/dev/null 2>&1; then
    jq . "$file" 2>/dev/null || cat "$file"
    return
  fi
  cat "$file"
}

join_csv_unique() {
  local combined=''
  local chunk item
  for chunk in "$@"; do
    [[ -n "$chunk" ]] || continue
    while IFS= read -r item; do
      item="$(trim "$item")"
      [[ -n "$item" ]] || continue
      if [[ ",${combined}," != *",${item},"* ]]; then
        combined="${combined:+${combined},}${item}"
      fi
    done < <(printf '%s\n' "$chunk" | tr ',' '\n')
  done
  printf '%s' "$combined"
}

BODY_FILE="${1:-}"
MODE="${2:-${ISSUE80_DIRECT_BETA_MODE:-caller_plus_oauth}}"
[[ -n "$BODY_FILE" ]] || usage
[[ -f "$BODY_FILE" ]] || { echo "error: body file not found: $BODY_FILE" >&2; exit 1; }

TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-${ANTHROPIC_OAUTH_ACCESS_TOKEN:-${ANTHROPIC_ACCESS_TOKEN:-}}}"
[[ -n "$TOKEN" ]] || {
  echo 'error: set CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_OAUTH_ACCESS_TOKEN, or ANTHROPIC_ACCESS_TOKEN' >&2
  exit 1
}

API_URL="${ISSUE80_ANTHROPIC_BASE_URL:-https://api.anthropic.com}"
ANTHROPIC_VERSION="${ISSUE80_ANTHROPIC_VERSION:-2023-06-01}"
CALLER_BETA_HEADER="${ISSUE80_CALLER_ANTHROPIC_BETA-fine-grained-tool-streaming-2025-05-14}"
OAUTH_BETA_HEADER='claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14'

case "$MODE" in
  caller_only)
    EFFECTIVE_BETA_HEADER="$(join_csv_unique "$CALLER_BETA_HEADER")"
    ;;
  caller_plus_oauth)
    EFFECTIVE_BETA_HEADER="$(join_csv_unique "$CALLER_BETA_HEADER" "$OAUTH_BETA_HEADER")"
    ;;
  oauth_only)
    EFFECTIVE_BETA_HEADER="$(join_csv_unique "$OAUTH_BETA_HEADER")"
    ;;
  none)
    EFFECTIVE_BETA_HEADER=''
    ;;
  *)
    echo "error: unsupported beta_mode: $MODE" >&2
    usage
    ;;
esac

REQUEST_LABEL="innies_diagnose_direct_$(date +%s)_$$"
OUT_DIR="${ISSUE80_OUT_DIR:-${TMPDIR:-/tmp}/innies_diagnose_direct_${REQUEST_LABEL}}"
mkdir -p "$OUT_DIR"

REQUEST_META_FILE="$OUT_DIR/request_meta.txt"
RESPONSE_HEADERS_FILE="$OUT_DIR/response_headers.txt"
RESPONSE_BODY_FILE="$OUT_DIR/response_body.txt"
BODY_SHA256="$(openssl dgst -sha256 -r "$BODY_FILE" | awk '{print $1}')"
BODY_BYTES="$(wc -c < "$BODY_FILE" | tr -d '[:space:]')"
TOKEN_KIND='bearer'
if [[ "$TOKEN" == *sk-ant-oat* ]]; then
  TOKEN_KIND='anthropic_oauth'
fi

{
  echo "api_url=${API_URL}/v1/messages"
  echo "request_label=${REQUEST_LABEL}"
  echo "beta_mode=${MODE}"
  echo "anthropic_version=${ANTHROPIC_VERSION}"
  echo "effective_anthropic_beta=${EFFECTIVE_BETA_HEADER}"
  echo "token_kind=${TOKEN_KIND}"
  echo "body_file=${BODY_FILE}"
  echo "body_sha256=${BODY_SHA256}"
  echo "body_bytes=${BODY_BYTES}"
} > "$REQUEST_META_FILE"

curl_cmd=(
  curl -sS
  -D "$RESPONSE_HEADERS_FILE"
  -o "$RESPONSE_BODY_FILE"
  -w '%{http_code}'
  -X POST "${API_URL}/v1/messages"
  -H "Authorization: Bearer ${TOKEN}"
  -H 'Content-Type: application/json'
  -H "anthropic-version: ${ANTHROPIC_VERSION}"
)

if [[ -n "$EFFECTIVE_BETA_HEADER" ]]; then
  curl_cmd+=(-H "anthropic-beta: ${EFFECTIVE_BETA_HEADER}")
fi

curl_cmd+=(--data-binary "@${BODY_FILE}")
STATUS="$("${curl_cmd[@]}")"

RESPONSE_CONTENT_TYPE="$(header_value "$RESPONSE_HEADERS_FILE" 'content-type')"
UPSTREAM_REQUEST_ID="$(header_value "$RESPONSE_HEADERS_FILE" 'request-id')"

echo "status=${STATUS}"
echo "request_id=${UPSTREAM_REQUEST_ID:-<missing>}"
echo "beta_mode=${MODE}"
echo "token_kind=${TOKEN_KIND}"
echo "artifacts_dir=${OUT_DIR}"
echo
echo "== response headers =="
sed 's/\r$//' "$RESPONSE_HEADERS_FILE"
echo
echo "== response body =="
print_body "$RESPONSE_BODY_FILE" "${RESPONSE_CONTENT_TYPE:-}"
