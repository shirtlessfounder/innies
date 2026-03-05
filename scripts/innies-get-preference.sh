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
api_key_input="$(prompt 'buyer key id or live key')"
api_key_id="$(resolve_buyer_key_id "$api_key_input")"
echo "buyerKeyId: $api_key_id"
run_request GET "${BASE_URL%/}/v1/admin/buyer-keys/$api_key_id/provider-preference" "$ADMIN_TOKEN"
