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

ensure_admin_token
credential_id="$(prompt 'token credential id (UUID)')"
require_nonempty 'token credential id' "$credential_id"
if ! is_uuid "$credential_id"; then
  echo 'error: token credential id must be a UUID' >&2
  exit 1
fi

refresh_input="$(prompt 'OAuth refresh token (type paste for clipboard, clear to remove)')"
refresh_input="$(trim "$refresh_input")"
if [[ "$refresh_input" == 'paste' ]]; then
  if ! command -v pbpaste >/dev/null 2>&1; then
    echo 'error: clipboard paste is not available on this machine' >&2
    exit 1
  fi
  refresh_token="$(pbpaste | tr -d '\r\n')"
  require_nonempty 'OAuth refresh token' "$refresh_token"
  body="{\"refreshToken\":\"$refresh_token\"}"
elif [[ "$refresh_input" == 'clear' ]]; then
  body='{"refreshToken":null}'
else
  require_nonempty 'OAuth refresh token' "$refresh_input"
  body="{\"refreshToken\":\"$refresh_input\"}"
fi

idk="$(prompt 'Idempotency-Key (press Enter to auto-generate)' "$(gen_idempotency_key)")"

echo "tokenCredentialId: $credential_id"
run_request PATCH "${BASE_URL%/}/v1/admin/token-credentials/$credential_id/refresh-token" "$ADMIN_TOKEN" "$idk" "$body"
