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

ensure_database_url
ensure_psql

echo 'Active and maxed token credentials:'
probe_rows="$(
  psql "$DATABASE_URL" -X -A -F $'\t' -t -v ON_ERROR_STOP=1 <<'SQL'
select
  id,
  coalesce(debug_label, ''),
  status,
  provider,
  coalesce(next_probe_at::text, '')
from in_token_credentials
where status in ('active', 'maxed')
  and expires_at > now()
order by
  case status when 'maxed' then 0 else 1 end,
  provider asc,
  coalesce(debug_label, '') asc,
  updated_at desc;
SQL
)"
probe_rows="$(printf '%s\n' "$probe_rows" | sed '/^[[:space:]]*$/d')"

if [[ -z "$probe_rows" ]]; then
  echo '  (none)'
else
  printf '%s\n' "$probe_rows" | while IFS=$'\t' read -r listed_id listed_label listed_status listed_provider listed_next_probe_at; do
    next_probe_suffix=''
    if [[ "$listed_status" == 'maxed' ]]; then
      next_probe_suffix=" nextProbeAt=${listed_next_probe_at:-null}"
    fi
    if [[ -n "$listed_label" ]]; then
      echo "  - ${listed_label} (${listed_provider}, ${listed_status}) id=${listed_id}${next_probe_suffix}"
    else
      echo "  - (no label) (${listed_provider}, ${listed_status}) id=${listed_id}${next_probe_suffix}"
    fi
  done
fi
echo

credential_input="$(prompt 'token credential id or exact debug label')"
credential_id="$(resolve_token_credential_id "$credential_input")"
selected_row="$(
  psql "$DATABASE_URL" -X -A -F $'\t' -t -v ON_ERROR_STOP=1 -v credential_id="$credential_id" 2>/dev/null <<'SQL'
select
  coalesce(debug_label, ''),
  provider,
  status,
  coalesce(next_probe_at::text, '')
from in_token_credentials
where id = :'credential_id'
  and status in ('active', 'maxed')
  and expires_at > now()
limit 1;
SQL
)"
selected_row="$(printf '%s' "$selected_row" | tr -d '\r\n')"
if [[ -z "$selected_row" ]]; then
  echo 'error: token credential not found, or it is not active/maxed' >&2
  exit 1
fi
IFS=$'\t' read -r selected_label selected_provider selected_status selected_next_probe_at <<< "$selected_row"
ensure_admin_token
idk="$(prompt 'Idempotency-Key (press Enter to auto-generate)' "$(gen_idempotency_key)")"

echo "tokenCredentialId: $credential_id"
echo 'Action: direct manual probe'
echo "current status: $selected_status"

headers_file="$(mktemp)"
body_file="$(mktemp)"
status="$(
  curl -sS \
    -D "$headers_file" \
    -o "$body_file" \
    -w '%{http_code}' \
    -X POST "${BASE_URL%/}/v1/admin/token-credentials/$credential_id/probe" \
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

probe_ok="$(jq -r '.probeOk // false' "$body_file")"
reactivated="$(jq -r '.reactivated // false' "$body_file")"
result_status="$(jq -r '.status // "unknown"' "$body_file")"
result_provider="$(jq -r '.provider // "unknown"' "$body_file")"
result_label="$(jq -r '.debugLabel // ""' "$body_file")"
result_reason="$(jq -r '.reason // "unknown"' "$body_file")"
result_upstream_status="$(jq -r '.upstreamStatus // "null"' "$body_file")"
result_next_probe_at="$(jq -r '.nextProbeAt // "null"' "$body_file")"

if [[ "$reactivated" == "true" ]]; then
  echo
  echo 'Probe result: REACTIVATED'
  if [[ -n "$result_label" ]]; then
    echo "credential: $result_label ($result_provider)"
  else
    echo "credential: $credential_id ($result_provider)"
  fi
  echo "upstream: ${result_upstream_status} (${result_reason})"
  echo "status: $result_status"
  echo 'summary: live probe succeeded; Innies flipped this credential back to active immediately.'
elif [[ "$probe_ok" == "true" ]]; then
  echo
  echo 'Probe result: PROBE OK, NO STATUS CHANGE'
  if [[ -n "$result_label" ]]; then
    echo "credential: $result_label ($result_provider)"
  else
    echo "credential: $credential_id ($result_provider)"
  fi
  echo "upstream: ${result_upstream_status} (${result_reason})"
  echo "status: $result_status"
  echo 'summary: upstream probe succeeded, but Innies did not mark the credential active.'
elif [[ "$selected_status" == "active" ]]; then
  echo
  echo 'Probe result: PROBE FAILED, NO STATUS CHANGE'
  if [[ -n "$result_label" ]]; then
    echo "credential: $result_label ($result_provider)"
  else
    echo "credential: $credential_id ($result_provider)"
  fi
  echo "upstream: ${result_upstream_status} (${result_reason})"
  echo "status: $result_status"
  echo 'summary: upstream probe failed; Innies left this credential active and did not schedule a recovery probe.'
else
  echo
  echo 'Probe result: STILL MAXED'
  if [[ -n "$result_label" ]]; then
    echo "credential: $result_label ($result_provider)"
  else
    echo "credential: $credential_id ($result_provider)"
  fi
  echo "upstream: ${result_upstream_status} (${result_reason})"
  echo "status: $result_status"
  echo "nextProbeAt: $result_next_probe_at"
  echo 'summary: live probe failed; Innies kept this credential maxed.'
fi

echo
echo 'raw response body:'
jq . "$body_file"
echo

rm -f "$headers_file" "$body_file"
