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

if [[ -z "${SELLER_SECRET_ENC_KEY_B64:-}" && -f "${ROOT_DIR}/api/.env" ]]; then
  SELLER_SECRET_ENC_KEY_B64="$(sed -n 's/^SELLER_SECRET_ENC_KEY_B64=//p' "${ROOT_DIR}/api/.env" | head -n 1)"
fi
export SELLER_SECRET_ENC_KEY_B64

ensure_admin_token
ensure_database_url
ensure_psql
if ! command -v node >/dev/null 2>&1; then
  echo 'error: node is required for this command' >&2
  exit 1
fi

list_manual_provider_usage_candidates() {
  psql "$DATABASE_URL" -X -A -F $'\x1f' -t -v ON_ERROR_STOP=1 <<'SQL'
select
  id,
  coalesce(debug_label, ''),
  provider,
  case
    when expires_at <= now() then 'expired'
    else status
  end as display_status,
  to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at_utc,
  auth_scheme,
  encode(encrypted_access_token, 'base64') as encrypted_access_token_b64
from in_token_credentials
where status <> 'revoked'
  and provider in ('anthropic', 'openai', 'codex')
  and (
    (status in ('active', 'paused', 'maxed') and expires_at > now())
    or (expires_at <= now() and encrypted_refresh_token is not null)
  )
order by
  case when expires_at <= now() then 1 else 0 end,
  provider asc,
  updated_at desc;
SQL
}

filter_manual_provider_usage_candidates() {
  node --input-type=module -e '
import { createDecipheriv } from "node:crypto";

const encodedKey = process.env.SELLER_SECRET_ENC_KEY_B64 ?? "";
const key = encodedKey ? Buffer.from(encodedKey, "base64") : null;

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

function decodeBase64UrlSegment(segment) {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded = padding === 0 ? normalized : normalized + "=".repeat(4 - padding);
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function parseOpenAiOauthAccessToken(accessToken) {
  const parts = accessToken.trim().split(".");
  if (parts.length !== 3) return null;

  const payloadJson = decodeBase64UrlSegment(parts[1]);
  if (!payloadJson) return null;

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return null;
  }

  const issuer = typeof payload.iss === "string" ? payload.iss.trim() : null;
  if (issuer !== "https://auth.openai.com") return null;

  const authClaim = payload["https://api.openai.com/auth"];
  const clientId = typeof payload.client_id === "string" && payload.client_id.trim().length > 0
    ? payload.client_id.trim()
    : null;
  const accountId = authClaim && typeof authClaim === "object" && !Array.isArray(authClaim)
    && typeof authClaim.chatgpt_account_id === "string" && authClaim.chatgpt_account_id.trim().length > 0
    ? authClaim.chatgpt_account_id.trim()
    : (typeof payload.chatgpt_account_id === "string" && payload.chatgpt_account_id.trim().length > 0
      ? payload.chatgpt_account_id.trim()
      : null);
  const audience = Array.isArray(payload.aud)
    ? payload.aud.filter((entry) => typeof entry === "string" && entry.trim().length > 0)
    : (typeof payload.aud === "string" && payload.aud.trim().length > 0 ? [payload.aud.trim()] : []);
  const hasOpenAiAudience = audience.some((entry) => entry.includes("api.openai.com"));

  if (!clientId && !accountId && !hasOpenAiAudience) return null;
  return { issuer, clientId, accountId };
}

function parseEnvelope(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed
      && parsed.v === 1
      && parsed.alg === "aes-256-gcm"
      && typeof parsed.iv === "string"
      && typeof parsed.tag === "string"
      && typeof parsed.ct === "string"
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function decryptSecret(encodedValue) {
  const raw = Buffer.from(encodedValue, "base64").toString("utf8");
  const envelope = parseEnvelope(raw);
  if (!envelope) {
    return raw;
  }
  if (!key || key.length !== 32) {
    throw new Error("SELLER_SECRET_ENC_KEY_B64 is required to filter encrypted OpenAI/Codex credentials");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ct, "base64")),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}

const input = await readStdin();
const lines = input.split(/\r?\n/).filter((line) => line.trim().length > 0);
const filtered = [];

for (const line of lines) {
  const parts = line.split("\x1f");
  if (parts.length < 7) continue;
  const [id, label, provider, displayStatus, updatedAtUtc, _authScheme, encryptedAccessTokenB64] = parts;

  if (provider === "anthropic") {
    filtered.push([id, label, provider, displayStatus, updatedAtUtc].join("\x1f"));
    continue;
  }

  const accessToken = decryptSecret(encryptedAccessTokenB64);
  if (parseOpenAiOauthAccessToken(accessToken)) {
    filtered.push([id, label, provider, displayStatus, updatedAtUtc].join("\x1f"));
  }
}

process.stdout.write(filtered.join("\n"));
'
}

echo 'Token credentials eligible for manual provider-usage refresh:'
credential_rows="$(
  list_manual_provider_usage_candidates | filter_manual_provider_usage_candidates
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
