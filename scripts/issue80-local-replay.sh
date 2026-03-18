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
usage: issue80-local-replay.sh <body.json>

Replays an Anthropic /v1/messages payload against local Innies, pins Anthropic,
saves artifacts, and prints DB evidence when DATABASE_URL + psql are available.
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

print_db_evidence() {
  local request_id="$1"

  if [[ -z "$DATABASE_URL" ]]; then
    echo "db_evidence=skipped reason=missing_DATABASE_URL"
    return
  fi
  if ! command -v psql >/dev/null 2>&1; then
    echo "db_evidence=skipped reason=missing_psql"
    return
  fi

  echo
  echo "== db routing events =="
  psql "$DATABASE_URL" -X -A -F $'\t' -t -v ON_ERROR_STOP=1 <<SQL
select
  request_id,
  attempt_no,
  provider,
  model,
  streaming,
  coalesce(upstream_status::text, ''),
  coalesce(error_code, ''),
  coalesce(route_decision->>'provider_selection_reason', route_decision->>'reason', ''),
  coalesce(route_decision->>'provider_preferred', ''),
  coalesce(route_decision->>'provider_effective', ''),
  coalesce(route_decision->>'tokenCredentialId', ''),
  coalesce(route_decision->>'tokenCredentialLabel', ''),
  coalesce(route_decision->'provider_plan', 'null'::jsonb)::text
from in_routing_events
where request_id = '$request_id'
order by created_at, attempt_no;
SQL

  echo
  echo "== db usage ledger =="
  psql "$DATABASE_URL" -X -A -F $'\t' -t -v ON_ERROR_STOP=1 <<SQL
select
  request_id,
  attempt_no,
  entry_type,
  provider,
  model,
  input_tokens,
  output_tokens,
  usage_units,
  coalesce(note, '')
from in_usage_ledger
where request_id = '$request_id'
order by created_at, attempt_no;
SQL

  echo
  echo "== db request log =="
  psql "$DATABASE_URL" -X -A -F $'\t' -t -v ON_ERROR_STOP=1 <<SQL
select
  request_id,
  attempt_no,
  provider,
  model,
  coalesce(prompt_preview, ''),
  coalesce(response_preview, '')
from in_request_log
where request_id = '$request_id'
order by created_at, attempt_no;
SQL
}

BODY_FILE="${1:-}"
[[ -n "$BODY_FILE" ]] || usage
[[ -f "$BODY_FILE" ]] || { echo "error: body file not found: $BODY_FILE" >&2; exit 1; }

ensure_buyer_token

API_URL="${BASE_URL%/}"
REQUEST_ID="${ISSUE80_REQUEST_ID:-innies_diagnose_local_$(date +%s)_$$}"
IDEMPOTENCY_KEY="${ISSUE80_IDEMPOTENCY_KEY:-innies_diagnose_local_$(gen_idempotency_key)}"
ANTHROPIC_VERSION="${ISSUE80_ANTHROPIC_VERSION:-2023-06-01}"
CALLER_BETA_HEADER="${ISSUE80_CALLER_ANTHROPIC_BETA-fine-grained-tool-streaming-2025-05-14}"
PIN_PROVIDER="${ISSUE80_PIN_PROVIDER:-true}"
OUT_DIR="${ISSUE80_OUT_DIR:-${TMPDIR:-/tmp}/innies_diagnose_local_${REQUEST_ID}}"
mkdir -p "$OUT_DIR"

REQUEST_META_FILE="$OUT_DIR/request_meta.txt"
RESPONSE_HEADERS_FILE="$OUT_DIR/response_headers.txt"
RESPONSE_BODY_FILE="$OUT_DIR/response_body.txt"
BODY_SHA256="$(openssl dgst -sha256 -r "$BODY_FILE" | awk '{print $1}')"
BODY_BYTES="$(wc -c < "$BODY_FILE" | tr -d '[:space:]')"

{
  echo "api_url=${API_URL}/v1/messages"
  echo "request_id=${REQUEST_ID}"
  echo "idempotency_key=${IDEMPOTENCY_KEY}"
  echo "pin_provider=${PIN_PROVIDER}"
  echo "anthropic_version=${ANTHROPIC_VERSION}"
  echo "caller_anthropic_beta=${CALLER_BETA_HEADER}"
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
  -H "Authorization: Bearer ${BUYER_TOKEN}"
  -H "x-request-id: ${REQUEST_ID}"
  -H "Idempotency-Key: ${IDEMPOTENCY_KEY}"
  -H 'Content-Type: application/json'
  -H "anthropic-version: ${ANTHROPIC_VERSION}"
)

if [[ -n "$CALLER_BETA_HEADER" ]]; then
  curl_cmd+=(-H "anthropic-beta: ${CALLER_BETA_HEADER}")
fi

if [[ "$PIN_PROVIDER" == "true" ]]; then
  curl_cmd+=(-H 'x-innies-provider-pin: true')
fi

curl_cmd+=(--data-binary "@${BODY_FILE}")
STATUS="$("${curl_cmd[@]}")"

RESPONSE_CONTENT_TYPE="$(header_value "$RESPONSE_HEADERS_FILE" 'content-type')"
RESPONSE_REQUEST_ID="$(header_value "$RESPONSE_HEADERS_FILE" 'x-request-id')"
TOKEN_CREDENTIAL_ID="$(header_value "$RESPONSE_HEADERS_FILE" 'x-innies-token-credential-id')"
ATTEMPT_NO="$(header_value "$RESPONSE_HEADERS_FILE" 'x-innies-attempt-no')"

echo "status=${STATUS}"
echo "request_id=${REQUEST_ID}"
echo "response_request_id=${RESPONSE_REQUEST_ID:-<missing>}"
echo "token_credential_id=${TOKEN_CREDENTIAL_ID:-<missing>}"
echo "attempt_no=${ATTEMPT_NO:-<missing>}"
echo "artifacts_dir=${OUT_DIR}"
echo
echo "== response headers =="
sed 's/\r$//' "$RESPONSE_HEADERS_FILE"
echo
echo "== response body =="
print_body "$RESPONSE_BODY_FILE" "${RESPONSE_CONTENT_TYPE:-}"
print_db_evidence "$REQUEST_ID"
