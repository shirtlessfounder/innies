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

echo 'Maxed token credentials:'
maxed_rows="$(
  psql "$DATABASE_URL" -X -A -F $'\t' -t -v ON_ERROR_STOP=1 <<'SQL'
select
  id,
  coalesce(debug_label, ''),
  provider,
  coalesce(next_probe_at::text, '')
from in_token_credentials
where status = 'maxed'
order by provider asc, coalesce(debug_label, '') asc, updated_at desc;
SQL
)"
maxed_rows="$(printf '%s\n' "$maxed_rows" | sed '/^[[:space:]]*$/d')"

if [[ -z "$maxed_rows" ]]; then
  echo '  (none)'
else
  printf '%s\n' "$maxed_rows" | while IFS=$'\t' read -r listed_id listed_label listed_provider listed_next_probe_at; do
    if [[ -n "$listed_label" ]]; then
      echo "  - ${listed_label} (${listed_provider}) id=${listed_id} nextProbeAt=${listed_next_probe_at:-null}"
    else
      echo "  - (no label) (${listed_provider}) id=${listed_id} nextProbeAt=${listed_next_probe_at:-null}"
    fi
  done
fi
echo

credential_input="$(prompt 'token credential id or exact debug label')"
credential_id="$(resolve_token_credential_id "$credential_input")"
ensure_admin_token
idk="$(prompt 'Idempotency-Key (press Enter to auto-generate)' "$(gen_idempotency_key)")"

echo "tokenCredentialId: $credential_id"
echo 'Action: direct manual probe'
run_request POST "${BASE_URL%/}/v1/admin/token-credentials/$credential_id/probe" "$ADMIN_TOKEN" "$idk"
