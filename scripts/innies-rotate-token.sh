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
provider="$(choose_provider 'provider')"
auth_scheme="$(auth_scheme_for_provider "$provider")"
credential_id="$(prompt 'credential ID to rotate (optional; press Enter to auto-select latest)')"
access_token="$(read_required_token 'new OAuth access token')"
refresh_token="$(read_optional_token 'new OAuth refresh token')"
label="$(prompt 'label (optional; press Enter to skip)')"
idk="$(prompt 'Idempotency-Key (press Enter to auto-generate)' "$(gen_idempotency_key)")"

body="{\"orgId\":\"$DEFAULT_ORG_ID\",\"provider\":\"$provider\",\"authScheme\":\"$auth_scheme\",\"accessToken\":\"$access_token\",\"expiresAt\":\"$DEFAULT_TOKEN_EXPIRES_AT\""
if [[ -n "$credential_id" ]]; then body+=",\"previousCredentialId\":\"$credential_id\""; fi
if [[ -n "$refresh_token" ]]; then body+=",\"refreshToken\":\"$refresh_token\""; fi
if [[ -n "$label" ]]; then body+=",\"debugLabel\":\"$label\""; fi
body+="}"

echo "orgId: $DEFAULT_ORG_ID"
echo "provider: $(display_provider_name "$provider")"
echo "authScheme: $auth_scheme (OAuth bearer token)"
run_request POST "${BASE_URL%/}/v1/admin/token-credentials/rotate" "$ADMIN_TOKEN" "$idk" "$body"
