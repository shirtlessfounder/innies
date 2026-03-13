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
credential_id=""
if [[ -n "${DATABASE_URL:-}" ]] && command -v psql >/dev/null 2>&1; then
  credential_rows="$(list_token_credentials_for_provider "$provider")"
  credential_rows="$(printf '%s\n' "$credential_rows" | sed '/^[[:space:]]*$/d')"
  if [[ -n "$credential_rows" ]]; then
    visible_credential_rows=()
    hidden_unlabeled_credential_rows=()
    while IFS=$'\x1f' read -r listed_id listed_label listed_status listed_updated_at; do
      row="${listed_id}"$'\x1f'"${listed_label}"$'\x1f'"${listed_status}"$'\x1f'"${listed_updated_at}"
      if [[ -n "$listed_label" || "$listed_status" == 'active' || "$listed_status" == 'maxed' ]]; then
        visible_credential_rows+=("$row")
      else
        hidden_unlabeled_credential_rows+=("$row")
      fi
    done <<< "$credential_rows"

    echo "Existing $(display_provider_name "$provider") credentials:"
    credential_ids=()
    selection_index=0

    for row in "${visible_credential_rows[@]}"; do
      IFS=$'\x1f' read -r listed_id listed_label listed_status listed_updated_at <<< "$row"
      selection_index=$((selection_index + 1))
      credential_ids+=("$listed_id")
      if [[ -n "$listed_label" ]]; then
        echo "  ${selection_index}) ${listed_label} (${listed_status}) id=${listed_id} updatedAt=${listed_updated_at}"
      else
        echo "  ${selection_index}) (no label) (${listed_status}) id=${listed_id} updatedAt=${listed_updated_at}"
      fi
    done
    if (( ${#hidden_unlabeled_credential_rows[@]} > 0 )); then
      echo "  [hidden ${#hidden_unlabeled_credential_rows[@]} unlabeled non-active/non-maxed credential(s)]"
    fi
    echo

    credential_input="$(prompt 'credential number, UUID, or exact debug label to rotate (press Enter to auto-select latest)')"
    if [[ -n "$credential_input" ]]; then
      if [[ "$credential_input" =~ ^[0-9]+$ ]]; then
        selection_number="$credential_input"
        if (( selection_number < 1 || selection_number > ${#credential_ids[@]} )); then
          echo "error: selection must be between 1 and ${#credential_ids[@]}" >&2
          exit 1
        fi
        credential_id="${credential_ids[$((selection_number - 1))]}"
      else
        credential_id="$(resolve_token_credential_id "$credential_input" "$provider")"
      fi
    fi
  else
    echo "No existing $(display_provider_name "$provider") credentials found; auto-select latest will be used." >&2
    credential_input="$(prompt 'credential UUID or exact debug label to rotate (optional; press Enter to auto-select latest)')"
    if [[ -n "$credential_input" ]]; then
      credential_id="$(resolve_token_credential_id "$credential_input" "$provider")"
    fi
  fi
else
  credential_input="$(prompt 'credential UUID or exact debug label to rotate (optional; press Enter to auto-select latest; DATABASE_URL needed for label lookup)')"
  if [[ -n "$credential_input" ]]; then
    credential_id="$(resolve_token_credential_id "$credential_input" "$provider")"
  fi
fi
access_token="$(read_required_token 'new OAuth access token')"
refresh_token="$(read_optional_token 'new OAuth refresh token')"
label="$(prompt 'label (optional; press Enter to keep previous label / skip)')"
idk="$(prompt 'Idempotency-Key (press Enter to auto-generate)' "$(gen_idempotency_key)")"

body="{\"orgId\":\"$DEFAULT_ORG_ID\",\"provider\":\"$provider\",\"authScheme\":\"$auth_scheme\",\"accessToken\":\"$access_token\",\"expiresAt\":\"$DEFAULT_TOKEN_EXPIRES_AT\""
if [[ -n "$credential_id" ]]; then body+=",\"previousCredentialId\":\"$credential_id\""; fi
if [[ -n "$refresh_token" ]]; then body+=",\"refreshToken\":\"$refresh_token\""; fi
if [[ -n "$label" ]]; then body+=",\"debugLabel\":\"$label\""; fi
body+="}"

echo "orgId: $DEFAULT_ORG_ID"
echo "provider: $(display_provider_name "$provider")"
echo "authScheme: $auth_scheme (OAuth bearer token)"
if [[ -n "$credential_id" ]]; then
  echo "previousCredentialId: $credential_id"
else
  echo "previousCredentialId: auto-select latest for provider"
fi
echo "routingNote: buyer-key fallback is automatic; this credential can be used when $(display_provider_name "$(alternate_provider "$provider")")-preferred traffic fails over"
run_request POST "${BASE_URL%/}/v1/admin/token-credentials/rotate" "$ADMIN_TOKEN" "$idk" "$body"
