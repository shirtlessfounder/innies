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

read_percent_with_default() {
  local label="$1"
  local default="$2"
  local value=""

  while true; do
    if ! value="$(prompt "$label" "$default")"; then
      exit 1
    fi
    if [[ "$value" =~ ^[0-9]+$ ]] && (( value >= 0 && value <= 100 )); then
      printf '%s' "$value"
      return
    fi
    echo 'enter a whole-number percent from 0 to 100' >&2
  done
}

lookup_claude_credential() {
  local credential_id="$1"

  psql "$DATABASE_URL" -X -A -F $'\x1f' -t -v ON_ERROR_STOP=1 -v credential_id="$credential_id" 2>/dev/null <<'SQL'
select
  id,
  coalesce(debug_label, ''),
  provider,
  status,
  coalesce(five_hour_reserve_percent, 0),
  coalesce(seven_day_reserve_percent, 0)
from in_token_credentials
where id = :'credential_id'
  and status in ('active', 'maxed')
limit 1;
SQL
}

ensure_admin_token
ensure_database_url
ensure_psql

echo 'Claude Code token credentials:'
credential_rows="$(
  psql "$DATABASE_URL" -X -A -F $'\x1f' -t -v ON_ERROR_STOP=1 <<'SQL'
select
  id,
  coalesce(debug_label, ''),
  status,
  coalesce(five_hour_reserve_percent, 0),
  coalesce(seven_day_reserve_percent, 0),
  to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at_utc
from in_token_credentials
where provider = 'anthropic'
  and status in ('active', 'maxed')
order by updated_at desc;
SQL
)"
credential_rows="$(printf '%s\n' "$credential_rows" | sed '/^[[:space:]]*$/d')"

credential_ids=()
if [[ -n "$credential_rows" ]]; then
  selection_index=0
  while IFS=$'\x1f' read -r listed_id listed_label listed_status listed_five_hour listed_seven_day listed_updated_at; do
    selection_index=$((selection_index + 1))
    credential_ids+=("$listed_id")
    if [[ -n "$listed_label" ]]; then
      echo "  ${selection_index}) ${listed_label} (${listed_status}) id=${listed_id} 5h=${listed_five_hour}% 7d=${listed_seven_day}% updatedAt=${listed_updated_at}"
    else
      echo "  ${selection_index}) (no label) (${listed_status}) id=${listed_id} 5h=${listed_five_hour}% 7d=${listed_seven_day}% updatedAt=${listed_updated_at}"
    fi
  done <<< "$credential_rows"
else
  echo '  (none)'
fi
echo

credential_input="$(prompt 'credential number, UUID, or exact debug label')"
credential_id=""
if [[ "$credential_input" =~ ^[0-9]+$ ]]; then
  selection_number="$credential_input"
  if (( selection_number < 1 || selection_number > ${#credential_ids[@]} )); then
    echo "error: selection must be between 1 and ${#credential_ids[@]}" >&2
    exit 1
  fi
  credential_id="${credential_ids[$((selection_number - 1))]}"
else
  credential_id="$(resolve_token_credential_id "$credential_input" "anthropic")"
fi

selected_row="$(lookup_claude_credential "$credential_id" | tr -d '\r\n')"
if [[ -z "$selected_row" ]]; then
  echo 'error: token credential not found, or it is not active/maxed' >&2
  exit 1
fi

IFS=$'\x1f' read -r selected_id selected_label selected_provider selected_status current_five_hour current_seven_day <<< "$selected_row"
if [[ "$selected_provider" != 'anthropic' ]]; then
  echo 'error: contribution caps are only supported for Claude Code credentials' >&2
  exit 1
fi

five_hour_reserve_percent="$(read_percent_with_default '5h reserve percent' "$current_five_hour")"
seven_day_reserve_percent="$(read_percent_with_default '7d reserve percent' "$current_seven_day")"
idk="$(prompt 'Idempotency-Key (press Enter to auto-generate)' "$(gen_idempotency_key)")"

body="{\"fiveHourReservePercent\":${five_hour_reserve_percent},\"sevenDayReservePercent\":${seven_day_reserve_percent}}"

echo "tokenCredentialId: $selected_id"
if [[ -n "$selected_label" ]]; then
  echo "label: $selected_label"
fi
echo "status: $selected_status"
echo "5h reserve percent: ${five_hour_reserve_percent}"
echo "7d reserve percent: ${seven_day_reserve_percent}"

run_request PATCH "${BASE_URL%/}/v1/admin/token-credentials/$selected_id/contribution-cap" "$ADMIN_TOKEN" "$idk" "$body"
