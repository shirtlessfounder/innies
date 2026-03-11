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
preferred="$(choose_preference)"
effective_provider="$(effective_preference_provider "$preferred")"
fallback_provider="$(alternate_provider "$effective_provider")"
idk="$(prompt 'Idempotency-Key (press Enter to auto-generate)' "$(gen_idempotency_key)")"

if [[ "$preferred" == 'null' ]]; then
  body='{"preferredProvider":null}'
else
  body="{\"preferredProvider\":\"$preferred\"}"
fi

echo "buyerKeyId: $api_key_id"
echo "effectivePreferredProvider: $(display_provider_name "$effective_provider")"
echo "autoFallbackProvider: $(display_provider_name "$fallback_provider")"
run_request PATCH "${BASE_URL%/}/v1/admin/buyer-keys/$api_key_id/provider-preference" "$ADMIN_TOKEN" "$idk" "$body"
