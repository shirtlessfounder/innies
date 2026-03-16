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

normalize_pause_action() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    pause|unpause)
      printf '%s' "$value"
      ;;
    *)
      return 1
      ;;
  esac
}

choose_pause_action() {
  local value=""
  while true; do
    if ! value="$(prompt 'action (pause/unpause)' "${1:-pause}")"; then
      exit 1
    fi
    if value="$(normalize_pause_action "$value")"; then
      printf '%s' "$value"
      return
    fi
    echo 'enter pause or unpause' >&2
  done
}

list_eligible_credentials() {
  local provider="$1"
  local action="$2"

  psql "$DATABASE_URL" -X -A -F $'\x1f' -t -v ON_ERROR_STOP=1 -v provider="$provider" -v action="$action" 2>/dev/null <<'SQL'
select
  id,
  coalesce(debug_label, ''),
  status,
  coalesce(to_char(rate_limited_until at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
  to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
from in_token_credentials
where provider = :'provider'
  and (
    (:'action' = 'pause' and status = 'active')
    or (:'action' = 'unpause' and status = 'paused')
  )
order by updated_at desc, rotation_version desc;
SQL
}

lookup_eligible_credential() {
  local credential_id="$1"
  local provider="$2"
  local action="$3"

  psql "$DATABASE_URL" -X -A -F $'\x1f' -t -v ON_ERROR_STOP=1 -v credential_id="$credential_id" -v provider="$provider" -v action="$action" 2>/dev/null <<'SQL'
select
  id,
  coalesce(debug_label, ''),
  status,
  provider,
  coalesce(to_char(rate_limited_until at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
  to_char(expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
from in_token_credentials
where id = :'credential_id'
  and provider = :'provider'
  and (
    (:'action' = 'pause' and status = 'active')
    or (:'action' = 'unpause' and status = 'paused')
  )
limit 1;
SQL
}

action="${1:-}"
if ! action="$(normalize_pause_action "$action")"; then
  action="$(choose_pause_action 'pause')"
fi

provider_input="${2:-}"
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

action_upper="$(printf '%s' "$action" | tr '[:lower:]' '[:upper:]')"
provider_display="$(display_provider_name "$provider")"
echo "${provider_display} token credentials eligible for ${action_upper}:"

credential_rows="$(list_eligible_credentials "$provider" "$action")"
credential_rows="$(printf '%s\n' "$credential_rows" | sed '/^[[:space:]]*$/d')"

credential_ids=()
if [[ -n "$credential_rows" ]]; then
  selection_index=0
  while IFS=$'\x1f' read -r listed_id listed_label listed_status listed_rate_limited_until listed_updated_at; do
    selection_index=$((selection_index + 1))
    credential_ids+=("$listed_id")
    if [[ -n "$listed_label" ]]; then
      echo "  ${selection_index}) ${listed_label} (${listed_status}) id=${listed_id} rateLimitedUntil=${listed_rate_limited_until:-null} updatedAt=${listed_updated_at}"
    else
      echo "  ${selection_index}) (no label) (${listed_status}) id=${listed_id} rateLimitedUntil=${listed_rate_limited_until:-null} updatedAt=${listed_updated_at}"
    fi
  done <<< "$credential_rows"
else
  echo '  (none)'
fi
echo

credential_input="${3:-}"
if [[ -z "$credential_input" ]]; then
  credential_input="$(prompt 'credential number, UUID, or exact debug label')"
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

selected_row="$(lookup_eligible_credential "$credential_id" "$provider" "$action" | tr -d '\r\n')"
if [[ -z "$selected_row" ]]; then
  if [[ "$action" == 'pause' ]]; then
    echo 'error: token credential not found, or it is not currently active' >&2
  else
    echo 'error: token credential not found, or it is not currently paused' >&2
  fi
  exit 1
fi

IFS=$'\x1f' read -r selected_id selected_label selected_status selected_provider selected_rate_limited_until selected_expires_at <<< "$selected_row"

ensure_admin_token
idk="$(prompt 'Idempotency-Key (press Enter to auto-generate)' "$(gen_idempotency_key)")"

echo "action: $action"
echo "tokenCredentialId: $selected_id"
if [[ -n "$selected_label" ]]; then
  echo "label: $selected_label"
fi
echo "provider: $(display_provider_name "$selected_provider")"
echo "current status: $selected_status"
echo "rateLimitedUntil: ${selected_rate_limited_until:-null}"
echo "expiresAt: $selected_expires_at"

run_request POST "${BASE_URL%/}/v1/admin/token-credentials/$selected_id/$action" "$ADMIN_TOKEN" "$idk"
