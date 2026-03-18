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

lookup_editable_credential() {
  local credential_id="$1"
  local provider="$2"

  psql "$DATABASE_URL" -X -A -F $'\x1f' -t -v ON_ERROR_STOP=1 -v credential_id="$credential_id" -v provider="$provider" 2>/dev/null <<'SQL'
select
  id,
  coalesce(debug_label, ''),
  status,
  provider,
  to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
from in_token_credentials
where id = :'credential_id'
  and provider = :'provider'
  and status <> 'revoked'
limit 1;
SQL
}

read_debug_label() {
  local value="${1:-}"

  while true; do
    if [[ -z "$value" ]]; then
      if ! value="$(prompt 'new label')"; then
        exit 1
      fi
    fi
    value="$(trim "$value")"
    if [[ -z "$value" ]]; then
      echo 'enter a non-empty label' >&2
      value=""
      continue
    fi
    if (( ${#value} > 64 )); then
      echo 'enter a label with at most 64 characters' >&2
      value=""
      continue
    fi
    printf '%s' "$value"
    return
  done
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

provider_input="${1:-}"
if [[ -n "$provider_input" ]]; then
  if ! provider="$(canonical_provider "$provider_input")"; then
    echo 'error: provider must be Claude Code or Codex' >&2
    exit 1
  fi
else
  provider="$(choose_provider 'provider')"
fi

ensure_database_url
ensure_psql

provider_display="$(display_provider_name "$provider")"
echo "Existing ${provider_display} credentials:"

credential_rows="$(list_token_credentials_for_provider "$provider")"
credential_rows="$(printf '%s\n' "$credential_rows" | sed '/^[[:space:]]*$/d')"

credential_ids=()
if [[ -n "$credential_rows" ]]; then
  selection_index=0
  while IFS=$'\x1f' read -r listed_id listed_label listed_status listed_updated_at; do
    selection_index=$((selection_index + 1))
    credential_ids+=("$listed_id")
    if [[ -n "$listed_label" ]]; then
      echo "  ${selection_index}) ${listed_label} (${listed_status}) id=${listed_id} updatedAt=${listed_updated_at}"
    else
      echo "  ${selection_index}) (no label) (${listed_status}) id=${listed_id} updatedAt=${listed_updated_at}"
    fi
  done <<< "$credential_rows"
else
  echo '  (none)'
fi
echo

credential_input="${2:-}"
if [[ -z "$credential_input" ]]; then
  credential_input="$(prompt 'credential number, UUID, or exact current debug label')"
fi

credential_id=""
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

selected_row="$(lookup_editable_credential "$credential_id" "$provider" | tr -d '\r\n')"
if [[ -z "$selected_row" ]]; then
  echo 'error: token credential not found, or it has been revoked' >&2
  exit 1
fi

IFS=$'\x1f' read -r selected_id selected_label selected_status selected_provider selected_updated_at <<< "$selected_row"
new_label="$(read_debug_label "${3:-}")"

ensure_admin_token
idk="$(prompt 'Idempotency-Key (press Enter to auto-generate)' "$(gen_idempotency_key)")"

escaped_label="$(json_escape "$new_label")"
body="{\"debugLabel\":\"${escaped_label}\"}"

echo "tokenCredentialId: $selected_id"
echo "provider: $(display_provider_name "$selected_provider")"
echo "current status: $selected_status"
echo "current label: ${selected_label:-null}"
echo "updatedAt: $selected_updated_at"
echo "new label: $new_label"

run_request PATCH "${BASE_URL%/}/v1/admin/token-credentials/$selected_id/label" "$ADMIN_TOKEN" "$idk" "$body"
