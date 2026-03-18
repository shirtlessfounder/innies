#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="${SCRIPT_DIR}/${SCRIPT_PATH}"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_common.sh"

usage() {
  cat >&2 <<'EOF'
usage: innies-diagnose-anthropic-pool [--all]

Print the Anthropic token pool with reserve percents and the latest provider
usage snapshot so 429/capacity issues can be diagnosed quickly.

default:
  active, unexpired credentials only

options:
  --all     include revoked/expired rows too
  --help    show this message
EOF
  exit 0
}

MODE='active'
while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)
      MODE='all'
      shift
      ;;
    --help|-h)
      usage
      ;;
    *)
      echo "error: unsupported arg: $1" >&2
      usage
      ;;
  esac
done

ensure_database_url
if ! command -v psql >/dev/null 2>&1; then
  echo 'error: psql is required' >&2
  exit 1
fi

where_clause="tc.provider = 'anthropic'"
if [[ "$MODE" == 'active' ]]; then
  where_clause="${where_clause} and tc.status = 'active' and tc.expires_at > now()"
fi

psql "$DATABASE_URL" -X -A -F $'\t' -v ON_ERROR_STOP=1 <<SQL
with latest as (
  select distinct on (token_credential_id)
    token_credential_id,
    fetched_at,
    five_hour_utilization_ratio,
    seven_day_utilization_ratio
  from in_token_credential_provider_usage
  order by token_credential_id, fetched_at desc
)
select
  'credential_id',
  'debug_label',
  'status',
  'five_hour_reserve_percent',
  'seven_day_reserve_percent',
  'usage_fetched_at_utc',
  'five_hour_utilization_ratio',
  'seven_day_utilization_ratio',
  'last_refresh_error'
union all
select
  tc.id::text,
  coalesce(tc.debug_label, ''),
  tc.status,
  tc.five_hour_reserve_percent::text,
  tc.seven_day_reserve_percent::text,
  coalesce(to_char(l.fetched_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
  coalesce(l.five_hour_utilization_ratio::text, ''),
  coalesce(l.seven_day_utilization_ratio::text, ''),
  coalesce(tc.last_refresh_error, '')
from in_token_credentials tc
left join latest l on l.token_credential_id = tc.id
where ${where_clause}
order by
  case tc.status
    when 'active' then 0
    when 'paused' then 1
    when 'maxed' then 2
    when 'expired' then 3
    when 'revoked' then 4
    else 9
  end,
  tc.updated_at desc;
SQL
