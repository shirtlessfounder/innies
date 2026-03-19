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
ensure_database_url
ensure_psql

echo 'Token credentials eligible for manual provider-usage refresh:'
credential_rows="$(
  psql "$DATABASE_URL" -X -A -F $'\x1f' -t -v ON_ERROR_STOP=1 <<'SQL'
select
  id,
  coalesce(debug_label, ''),
  provider,
  case
    when expires_at <= now() then 'expired'
    else status
  end as display_status,
  to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at_utc
from in_token_credentials
where status <> 'revoked'
  and provider in ('anthropic', 'openai')
  and (
    (status in ('active', 'paused', 'maxed') and expires_at > now())
    or (expires_at <= now() and encrypted_refresh_token is not null)
  )
order by
  case when expires_at <= now() then 1 else 0 end,
  provider asc,
  updated_at desc;
SQL
)"
credential_rows="$(printf '%s\n' "$credential_rows" | sed '/^[[:space:]]*$/d')"

credential_ids=()
if [[ -n "$credential_rows" ]]; then
  selection_index=0
  while IFS=$'\x1f' read -r listed_id listed_label listed_provider listed_status listed_updated_at; do
    selection_index=$((selection_index + 1))
    credential_ids+=("$listed_id")
    if [[ -n "$listed_label" ]]; then
      echo "  ${selection_index}) ${listed_label} (${listed_provider}, ${listed_status}) id=${listed_id} updatedAt=${listed_updated_at}"
    else
      echo "  ${selection_index}) (no label) (${listed_provider}, ${listed_status}) id=${listed_id} updatedAt=${listed_updated_at}"
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
  credential_id="$(resolve_token_credential_id "$credential_input")"
fi

idk="$(prompt 'Idempotency-Key (press Enter to auto-generate)' "$(gen_idempotency_key)")"

echo "tokenCredentialId: $credential_id"
echo 'Action: direct provider-usage refresh'

headers_file="$(mktemp)"
body_file="$(mktemp)"
status="$(
  curl -sS \
    -D "$headers_file" \
    -o "$body_file" \
    -w '%{http_code}' \
    -X POST "${BASE_URL%/}/v1/admin/token-credentials/$credential_id/provider-usage-refresh" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Idempotency-Key: $idk" \
    -H 'Content-Type: application/json'
)"

if [[ "$status" != "200" ]]; then
  print_response "$status" "$headers_file" "$body_file"
  rm -f "$headers_file" "$body_file"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  print_response "$status" "$headers_file" "$body_file"
  rm -f "$headers_file" "$body_file"
  exit 0
fi

refresh_ok="$(jq -r '.refreshOk // false' "$body_file")"
result_provider="$(jq -r '.provider // "unknown"' "$body_file")"
result_label="$(jq -r '.debugLabel // ""' "$body_file")"
result_status="$(jq -r '.status // "unknown"' "$body_file")"
result_reason="$(jq -r '.reason // "unknown"' "$body_file")"
result_upstream_status="$(jq -r '.upstreamStatus // "null"' "$body_file")"
warning_reason="$(jq -r '.warningReason // "null"' "$body_file")"
retry_after_ms="$(jq -r '.retryAfterMs // "null"' "$body_file")"
next_probe_at="$(jq -r '.nextProbeAt // "null"' "$body_file")"
state_sync_errors="$(jq -c '.stateSyncErrors // []' "$body_file")"

if [[ "$refresh_ok" == "true" ]]; then
  five_hour_used_percent="$(jq -r '.snapshot.fiveHourUsedPercent // "null"' "$body_file")"
  five_hour_resets_at="$(jq -r '.snapshot.fiveHourResetsAt // "null"' "$body_file")"
  five_hour_cap_exhausted="$(jq -r '.snapshot.fiveHourContributionCapExhausted // "null"' "$body_file")"
  seven_day_used_percent="$(jq -r '.snapshot.sevenDayUsedPercent // "null"' "$body_file")"
  seven_day_resets_at="$(jq -r '.snapshot.sevenDayResetsAt // "null"' "$body_file")"
  seven_day_cap_exhausted="$(jq -r '.snapshot.sevenDayContributionCapExhausted // "null"' "$body_file")"

  echo
  echo 'Usage refresh result: SUCCESS'
  if [[ -n "$result_label" ]]; then
    echo "credential: $result_label ($result_provider)"
  else
    echo "credential: $credential_id ($result_provider)"
  fi
  echo "status: $result_status"
  echo "upstream: ${result_upstream_status} (${result_reason})"
  echo "5h used: ${five_hour_used_percent}%"
  echo "5h reset: ${five_hour_resets_at}"
  if [[ "$five_hour_cap_exhausted" != "null" ]]; then
    echo "5h cap exhausted: ${five_hour_cap_exhausted}"
  fi
  echo "7d used: ${seven_day_used_percent}%"
  echo "7d reset: ${seven_day_resets_at}"
  if [[ "$seven_day_cap_exhausted" != "null" ]]; then
    echo "7d cap exhausted: ${seven_day_cap_exhausted}"
  fi
else
  echo
  echo 'Usage refresh result: FAILED'
  if [[ -n "$result_label" ]]; then
    echo "credential: $result_label ($result_provider)"
  else
    echo "credential: $credential_id ($result_provider)"
  fi
  echo "status: $result_status"
  echo "upstream: ${result_upstream_status} (${result_reason})"
  echo "warningReason: ${warning_reason}"
  echo "retryAfterMs: ${retry_after_ms}"
  if [[ "$next_probe_at" != "null" ]]; then
    echo "nextProbeAt: ${next_probe_at}"
  fi
fi

if [[ "$state_sync_errors" != "[]" ]]; then
  echo "stateSyncErrors: $state_sync_errors"
fi

echo
echo 'raw response body:'
jq . "$body_file"
echo

rm -f "$headers_file" "$body_file"
