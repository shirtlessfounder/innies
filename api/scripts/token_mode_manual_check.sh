#!/usr/bin/env bash
set -euo pipefail

# DB-backed token-mode manual evidence check for C1 pilot.
# Required env:
#   HEADROOM_API_URL            e.g. http://localhost:4010
#   HEADROOM_BUYER_API_KEY      buyer or admin API key
#   HEADROOM_ORG_ID             org UUID
#   HEADROOM_IDEMPOTENCY_KEY    UUIDv7 or opaque >= 32 chars
# Optional env:
#   HEADROOM_MODEL              default claude-3-5-sonnet-latest
#   DATABASE_URL                required for DB evidence queries (psql)

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "missing required env: $name"
    exit 1
  fi
}

require_env HEADROOM_API_URL
require_env HEADROOM_BUYER_API_KEY
require_env HEADROOM_ORG_ID
require_env HEADROOM_IDEMPOTENCY_KEY

MODEL="${HEADROOM_MODEL:-claude-3-5-sonnet-latest}"
API_URL="${HEADROOM_API_URL%/}"
OUT_DIR="${TMPDIR:-/tmp}/innies_token_check_$$"
mkdir -p "$OUT_DIR"

HEADERS_FILE="$OUT_DIR/headers.txt"
BODY_FILE="$OUT_DIR/body.json"

echo "[1/3] sending token-mode non-streaming proxy request..."
STATUS="$(curl -sS -D "$HEADERS_FILE" -o "$BODY_FILE" -w "%{http_code}" \
  -X POST "$API_URL/v1/proxy/v1/messages" \
  -H "Authorization: Bearer $HEADROOM_BUYER_API_KEY" \
  -H "Idempotency-Key: $HEADROOM_IDEMPOTENCY_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d "{\"provider\":\"anthropic\",\"model\":\"$MODEL\",\"streaming\":false,\"payload\":{\"model\":\"$MODEL\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"reply with one word: ok\"}]}}")"

REQUEST_ID="$(awk -F': ' 'BEGIN{IGNORECASE=1} /^x-request-id:/{gsub("\r","",$2);print $2}' "$HEADERS_FILE" | tail -1)"
TOKEN_CRED_ID="$(awk -F': ' 'BEGIN{IGNORECASE=1} /^x-innies-token-credential-id:/{gsub("\r","",$2);print $2}' "$HEADERS_FILE" | tail -1)"
if [[ -z "${TOKEN_CRED_ID:-}" ]]; then
  TOKEN_CRED_ID="$(awk -F': ' 'BEGIN{IGNORECASE=1} /^x-headroom-token-credential-id:/{gsub("\r","",$2);print $2}' "$HEADERS_FILE" | tail -1)"
fi

echo "upstream_status=$STATUS"
echo "request_id=${REQUEST_ID:-<missing>}"
echo "token_credential_id=${TOKEN_CRED_ID:-<missing>}"

if [[ "$STATUS" -lt 200 || "$STATUS" -gt 299 ]]; then
  echo "proxy call failed:"
  cat "$BODY_FILE"
  exit 1
fi

if [[ -z "$TOKEN_CRED_ID" ]]; then
  echo "missing x-innies-token-credential-id header; token route evidence failed"
  cat "$HEADERS_FILE"
  exit 1
fi

echo "[2/3] payload sample:"
cat "$BODY_FILE"
echo

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[3/3] DATABASE_URL not set; skipping DB evidence queries."
  echo "artifacts: $OUT_DIR"
  exit 0
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "[3/3] psql not found; skipping DB evidence queries."
  echo "artifacts: $OUT_DIR"
  exit 0
fi

echo "[3/3] querying DB evidence..."
USAGE_LEDGER_ID="$(psql "$DATABASE_URL" -tA -c "select id from hr_usage_ledger where org_id = '$HEADROOM_ORG_ID' and request_id = '$REQUEST_ID' order by created_at desc limit 1;")"
AUDIT_LOG_ID="$(psql "$DATABASE_URL" -tA -c "select id from hr_audit_log_events where target_type = 'token_credential' and target_id = '$TOKEN_CRED_ID' order by created_at desc limit 1;")"

echo "usage_ledger_row_id=${USAGE_LEDGER_ID:-<missing>}"
echo "audit_log_row_id=${AUDIT_LOG_ID:-<missing>}"
echo "artifacts: $OUT_DIR"
