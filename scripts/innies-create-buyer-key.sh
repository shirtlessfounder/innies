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

org_id="$(prompt 'org id' "$DEFAULT_ORG_ID")"
if ! is_uuid "$org_id"; then
  echo 'error: org id must be a UUID' >&2
  exit 1
fi

name="$(prompt 'buyer label')"
require_nonempty 'buyer label' "$name"

preferred="$(choose_preference)"
effective_provider="$(effective_preference_provider "$preferred")"
fallback_provider="$(alternate_provider "$effective_provider")"
expires_at="$(prompt 'expires at (optional ISO8601; press Enter for no expiry)')"

api_key_id="$(gen_uuid)"
live_key="$(gen_live_buyer_key)"
key_hash="$(sha256_hex "$live_key")"
preferred_provider_sql=''
if [[ "$preferred" != 'null' ]]; then
  preferred_provider_sql="$preferred"
fi

inserted_row="$(
  psql "$DATABASE_URL" -X -A -F $'\t' -t -v ON_ERROR_STOP=1 \
    -v api_key_id="$api_key_id" \
    -v org_id="$org_id" \
    -v name="$name" \
    -v key_hash="$key_hash" \
    -v preferred_provider="$preferred_provider_sql" \
    -v expires_at="$expires_at" <<'SQL'
insert into in_api_keys (
  id,
  org_id,
  name,
  key_hash,
  scope,
  is_active,
  expires_at,
  preferred_provider,
  provider_preference_updated_at
)
values (
  :'api_key_id'::uuid,
  :'org_id'::uuid,
  :'name',
  :'key_hash',
  'buyer_proxy',
  true,
  nullif(:'expires_at', '')::timestamptz,
  nullif(:'preferred_provider', ''),
  case
    when nullif(:'preferred_provider', '') is null then null
    else now()
  end
)
returning
  id,
  org_id,
  name,
  coalesce(preferred_provider, ''),
  coalesce(expires_at::text, '');
SQL
)"

inserted_row="$(printf '%s\n' "$inserted_row" | sed '/^[[:space:]]*$/d' | tail -n 1)"
IFS=$'\t' read -r inserted_id inserted_org_id inserted_name inserted_preferred inserted_expires_at <<<"$inserted_row"

echo "buyerKeyId: $inserted_id"
echo "orgId: $inserted_org_id"
echo "label: $inserted_name"
if [[ -n "$inserted_preferred" ]]; then
  echo "preferredProvider: $(display_provider_name "$inserted_preferred")"
  echo 'preferenceSource: explicit'
else
  echo "preferredProvider: $(display_provider_name "$effective_provider")"
  echo 'preferenceSource: default'
fi
echo "autoFallbackProvider: $(display_provider_name "$fallback_provider")"
if [[ -n "$inserted_expires_at" ]]; then
  echo "expiresAt: $inserted_expires_at"
else
  echo 'expiresAt: none'
fi
echo
echo "buyerKey: $live_key"
echo 'note: live buyer key is only shown once; store it now.'
