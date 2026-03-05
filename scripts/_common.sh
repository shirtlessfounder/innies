#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="${SCRIPT_DIR}/${SCRIPT_PATH}"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${INNIES_ENV_FILE:-${ROOT_DIR}/scripts/.env.local}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${DATABASE_URL:-}" && -f "${ROOT_DIR}/api/.env" ]]; then
  DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "${ROOT_DIR}/api/.env" | head -n 1)"
fi

BASE_URL="${INNIES_BASE_URL:-http://localhost:4010}"
ADMIN_TOKEN="${INNIES_ADMIN_API_KEY:-}"
BUYER_TOKEN="${INNIES_BUYER_API_KEY:-}"
DATABASE_URL="${DATABASE_URL:-}"
DEFAULT_ORG_ID="${INNIES_ORG_ID:-818d0cc7-7ed2-469f-b690-a977e72a921d}"
DEFAULT_TOKEN_EXPIRES_AT="${INNIES_TOKEN_DEFAULT_EXPIRES_AT:-2099-12-31T00:00:00Z}"

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

prompt() {
  local label="$1"
  local default="${2:-}"
  local value
  if [[ -n "$default" ]]; then
    if ! read -r -p "$label [$default]: " value; then
      echo >&2
      return 1
    fi
    value="$(trim "${value:-}")"
    if [[ -z "$value" ]]; then
      value="$default"
    fi
  else
    if ! read -r -p "$label: " value; then
      echo >&2
      return 1
    fi
    value="$(trim "${value:-}")"
  fi
  printf '%s' "$value"
}

prompt_secret() {
  local label="$1"
  local value
  if ! read -r -p "$label: " value; then
    echo >&2
    return 1
  fi
  printf '%s' "$value"
}

require_nonempty() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    echo "error: missing required value for $name" >&2
    exit 1
  fi
}

gen_idempotency_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  else
    printf '%s%s' "$(date +%s)" "_innies_idempotency_key_fallback_000000"
  fi
}

is_uuid() {
  [[ "${1:-}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]
}

sha256_hex() {
  local value="$1"
  printf '%s' "$value" | openssl dgst -sha256 -r | awk '{print $1}'
}

ensure_admin_token() {
  if [[ -z "$ADMIN_TOKEN" ]]; then
    if ! ADMIN_TOKEN="$(prompt_secret 'admin API key (press Enter to cancel)')"; then
      exit 1
    fi
  fi
  require_nonempty 'admin API key' "$ADMIN_TOKEN"
}

ensure_buyer_token() {
  if [[ -z "$BUYER_TOKEN" ]]; then
    if ! BUYER_TOKEN="$(prompt_secret 'buyer API key (press Enter to cancel)')"; then
      exit 1
    fi
  fi
  require_nonempty 'buyer API key' "$BUYER_TOKEN"
}

canonical_provider() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    claude|claude-code|claude\ code|anthropic)
      printf 'anthropic'
      ;;
    codex|openai)
      printf 'openai'
      ;;
    null|none)
      printf 'null'
      ;;
    *)
      return 1
      ;;
  esac
}

display_provider_name() {
  case "${1:-}" in
    anthropic) printf 'Claude Code' ;;
    openai) printf 'Codex' ;;
    null) printf 'null' ;;
    *) printf '%s' "${1:-}" ;;
  esac
}

choose_provider() {
  local label="$1"
  local value
  while true; do
    if ! value="$(prompt "$label (Claude Code/Codex)")"; then
      exit 1
    fi
    if value="$(canonical_provider "$value")"; then
      printf '%s' "$value"
      return
    fi
    echo 'enter Claude Code or Codex' >&2
  done
}

choose_preference() {
  local value
  while true; do
    if ! value="$(prompt 'preferred provider (Claude Code/Codex/null)')"; then
      exit 1
    fi
    if value="$(canonical_provider "$value")"; then
      printf '%s' "$value"
      return
    fi
    echo 'enter Claude Code, Codex, or null' >&2
  done
}

auth_scheme_for_provider() {
  printf 'bearer'
}

read_required_token() {
  local label="$1"
  local value=""
  if command -v pbpaste >/dev/null 2>&1; then
    if ! prompt "copy ${label} to clipboard, then press Enter" >/dev/null; then
      exit 1
    fi
    value="$(pbpaste | tr -d '\r\n')"
  else
    if ! value="$(prompt_secret "$label")"; then
      exit 1
    fi
  fi
  require_nonempty "$label" "$value"
  printf '%s' "$value"
}

resolve_buyer_key_id() {
  local input="$1"
  local key_hash
  local resolved_id

  input="$(trim "$input")"
  require_nonempty 'buyer key id or live key' "$input"

  if is_uuid "$input"; then
    printf '%s' "$input"
    return
  fi

  if [[ "$input" != in_* ]]; then
    echo 'error: enter a buyer key UUID or a live buyer key value starting with in_' >&2
    exit 1
  fi

  if [[ -z "$DATABASE_URL" ]]; then
    echo 'error: DATABASE_URL is required to resolve a live buyer key' >&2
    exit 1
  fi

  if ! command -v psql >/dev/null 2>&1; then
    echo 'error: psql is required to resolve a live buyer key' >&2
    exit 1
  fi

  key_hash="$(sha256_hex "$input")"
  resolved_id="$(
    psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
      -c "select id from in_api_keys where key_hash = '${key_hash}' and scope = 'buyer_proxy' limit 1;" \
      2>/dev/null | tr -d '\r\n'
  )"

  if [[ -z "$resolved_id" ]]; then
    echo 'error: no buyer key record found for that live key' >&2
    exit 1
  fi

  printf '%s' "$resolved_id"
}

print_response() {
  local status="$1"
  local headers_file="$2"
  local body_file="$3"
  echo "status: $status"
  echo 'response headers:'
  sed 's/\r$//' "$headers_file"
  echo 'response body:'
  if command -v jq >/dev/null 2>&1; then
    jq . "$body_file" 2>/dev/null || cat "$body_file"
  else
    cat "$body_file"
  fi
  echo
}

run_request() {
  local method="$1"
  local url="$2"
  local token="$3"
  local idempotency_key="${4:-}"
  local payload="${5:-}"

  local headers_file body_file status
  headers_file="$(mktemp)"
  body_file="$(mktemp)"

  local -a cmd
  cmd=(curl -sS -D "$headers_file" -o "$body_file" -w '%{http_code}' -X "$method" "$url")
  if [[ -n "$token" ]]; then
    cmd+=(-H "Authorization: Bearer $token")
  fi
  if [[ -n "$idempotency_key" ]]; then
    cmd+=(-H "Idempotency-Key: $idempotency_key")
  fi
  cmd+=(-H 'Content-Type: application/json')
  if [[ -n "$payload" ]]; then
    cmd+=(--data-binary "$payload")
  fi

  status="$("${cmd[@]}")"
  print_response "$status" "$headers_file" "$body_file"
  rm -f "$headers_file" "$body_file"
}
