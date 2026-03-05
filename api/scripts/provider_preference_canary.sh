#!/usr/bin/env bash
set -euo pipefail

# Agent 3 check script for per-buyer-key provider preference validation.
#
# Required env:
#   INNIES_BASE_URL or INNIES_API_URL
#   INNIES_BUYER_API_KEY
#   INNIES_IDEMPOTENCY_PREFIX
#   INNIES_MODEL_ANTHROPIC
# Optional env:
#   INNIES_MODEL_CODEX        required for openai/codex preference scenarios
#   INNIES_EXPECTED_PREFERRED_PROVIDER
#   INNIES_PREFERENCE_MODEL   model used for omitted-provider primary preference-path check
#   INNIES_BUYER_API_KEY_B
#   INNIES_SECONDARY_EXPECTED_PREFERRED_PROVIDER
#   INNIES_SECONDARY_PREFERENCE_MODEL
#   INNIES_PINNED_PROVIDER    defaults to anthropic
#   INNIES_PINNED_MODEL       defaults to INNIES_MODEL_ANTHROPIC
#   INNIES_SESSION_ID_PREFIX
#   DATABASE_URL (for DB evidence checks)
#   INNIES_ORG_ID (required only for DB evidence checks)

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "missing required env: $name" >&2
    exit 1
  fi
}

require_env INNIES_BUYER_API_KEY
require_env INNIES_IDEMPOTENCY_PREFIX
require_env INNIES_MODEL_ANTHROPIC

canonicalize_provider() {
  local provider="${1:-}"
  provider="$(printf '%s' "$provider" | tr '[:upper:]' '[:lower:]')"
  case "$provider" in
    codex|openai) printf 'openai' ;;
    anthropic) printf 'anthropic' ;;
    *)
      echo "unsupported provider: $1" >&2
      exit 1
      ;;
  esac
}

resolve_api_url() {
  if [[ -n "${INNIES_BASE_URL:-}" ]]; then
    printf '%s' "${INNIES_BASE_URL%/}"
    return
  fi
  if [[ -n "${INNIES_API_URL:-}" ]]; then
    printf '%s' "${INNIES_API_URL%/}"
    return
  fi
  echo "missing INNIES_BASE_URL or INNIES_API_URL" >&2
  exit 1
}

API_URL="$(resolve_api_url)"
SESSION_PREFIX="${INNIES_SESSION_ID_PREFIX:-pref_canary_$(date +%s)}"
PREFERENCE_SESSION_ID="${SESSION_PREFIX}_preference"
SECONDARY_PREFERENCE_SESSION_ID="${SESSION_PREFIX}_preference_secondary"
PINNED_SESSION_ID="${SESSION_PREFIX}_pinned"
RUN_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TMP_DIR="${TMPDIR:-/tmp}/innies_pref_canary_$$"
REQUESTS_FILE="$TMP_DIR/requests.tsv"
mkdir -p "$TMP_DIR"
: > "$REQUESTS_FILE"

unique_suffix() {
  if date +%s%N >/dev/null 2>&1; then
    date +%s%N
  else
    printf '%s%s' "$(date +%s)" "$$"
  fi
}

model_for_provider() {
  local provider
  provider="$(canonicalize_provider "$1")"
  case "$provider" in
    anthropic)
      printf '%s' "$INNIES_MODEL_ANTHROPIC"
      ;;
    openai)
      if [[ -z "${INNIES_MODEL_CODEX:-}" ]]; then
        echo "missing INNIES_MODEL_CODEX for provider $provider" >&2
        exit 1
      fi
      printf '%s' "$INNIES_MODEL_CODEX"
      ;;
  esac
}

send_proxy_request() {
  local scenario="$1"
  local buyer_token="$2"
  local provider_mode="$3"
  local model="$4"
  local streaming="$5"
  local session_id="$6"
  local pin_request="${7:-false}"
  local expected_provider="${8:-}"
  local idk="${INNIES_IDEMPOTENCY_PREFIX}_${scenario}_$(unique_suffix)"
  local headers_file="$TMP_DIR/${scenario}_headers.txt"
  local body_file="$TMP_DIR/${scenario}_body.txt"
  local request_id="pref_${scenario}_$(unique_suffix)_$$"
  local payload

  if [[ "$provider_mode" == "__omit__" ]]; then
    payload="$(printf '{"model":"%s","streaming":%s,"payload":{"model":"%s","max_tokens":32,"messages":[{"role":"user","content":"reply with one word: ok"}]}}' \
      "$model" "$streaming" "$model")"
  else
    payload="$(printf '{"provider":"%s","model":"%s","streaming":%s,"payload":{"model":"%s","max_tokens":32,"messages":[{"role":"user","content":"reply with one word: ok"}]}}' \
      "$provider_mode" "$model" "$streaming" "$model")"
  fi

  local status
  local -a curl_cmd
  curl_cmd=(curl -sS -D "$headers_file" -o "$body_file" -w "%{http_code}" \
    -X POST "$API_URL/v1/proxy/v1/messages" \
    -H "Authorization: Bearer $buyer_token" \
    -H "Idempotency-Key: $idk" \
    -H "x-request-id: $request_id" \
    -H "x-openclaw-session-id: $session_id" \
    -H "Content-Type: application/json" \
    -H "anthropic-version: 2023-06-01")
  if [[ "$pin_request" == "true" ]]; then
    curl_cmd+=(-H "x-innies-provider-pin: true")
  fi
  curl_cmd+=(-d "$payload")
  status="$("${curl_cmd[@]}")"

  local route_key token_cred
  route_key="$(awk -F': ' 'BEGIN{IGNORECASE=1} /^x-innies-upstream-key-id:/{gsub("\r","",$2);print $2}' "$headers_file" | tail -1)"
  token_cred="$(awk -F': ' 'BEGIN{IGNORECASE=1} /^x-innies-token-credential-id:/{gsub("\r","",$2);print $2}' "$headers_file" | tail -1)"

  echo "scenario=$scenario status=$status provider_mode=$provider_mode model=$model request_id=$request_id session_id=$session_id token_credential_id=${token_cred:-<none>} upstream_key_id=${route_key:-<none>}"
  echo "headers_file=$headers_file body_file=$body_file"
  if [[ "$status" -lt 200 || "$status" -gt 299 ]]; then
    echo "body:"
    cat "$body_file"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$scenario" "$request_id" "$status" "$provider_mode" "$model" "${expected_provider:-<none>}" "$headers_file" "$body_file" >> "$REQUESTS_FILE"
}

print_db_evidence() {
  local scenario="$1"
  local request_id="$2"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA -F $'\t' -c "
    select
      request_id,
      attempt_no,
      provider,
      upstream_status,
      coalesce(error_code, ''),
      coalesce(route_decision->>'reason', ''),
      coalesce(route_decision->>'provider_selection_reason', ''),
      coalesce(route_decision->>'provider_preferred', ''),
      coalesce(route_decision->>'provider_effective', ''),
      coalesce(route_decision->>'provider_fallback_from', ''),
      coalesce(route_decision->>'provider_fallback_reason', ''),
      coalesce(route_decision->>'provider_plan', '')
    from in_routing_events
    where org_id = '$INNIES_ORG_ID'
      and request_id = '$request_id'
    order by attempt_no
  " | awk -F '\t' -v scenario="$scenario" '{
    printf "db scenario=%s request_id=%s attempt_no=%s provider=%s upstream_status=%s error_code=%s reason=%s selection_reason=%s preferred=%s effective=%s fallback_from=%s fallback_reason=%s provider_plan=%s\n",
      scenario, $1, $2, $3, $4, ($5==""?"<none>":$5), ($6==""?"<none>":$6), ($7==""?"<none>":$7), ($8==""?"<none>":$8), ($9==""?"<none>":$9), ($10==""?"<none>":$10), ($11==""?"<none>":$11), ($12==""?"<none>":$12)
  }'
}

validate_preference_metadata() {
  local scenario="$1"
  local request_id="$2"
  local expected_provider="$3"
  local summary
  summary="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA -F $'\t' -c "
    select
      count(*) filter (
        where coalesce(route_decision->>'provider_selection_reason', route_decision->>'reason', '') = 'preferred_provider_selected'
          and coalesce(route_decision->>'provider_preferred', '') = '$expected_provider'
          and coalesce(route_decision->>'provider_effective', '') = '$expected_provider'
      ),
      count(*) filter (
        where coalesce(route_decision->>'provider_preferred', '') = '$expected_provider'
      ),
      count(*) filter (
        where coalesce(route_decision->>'provider_effective', '') = '$expected_provider'
      ),
      count(*) filter (
        where jsonb_typeof(route_decision->'provider_plan') = 'array'
          and route_decision->'provider_plan' ? '$expected_provider'
      )
    from in_routing_events
    where org_id = '$INNIES_ORG_ID'
      and request_id = '$request_id'
  ")"

  local exact_matches preferred_matches effective_matches provider_plan_matches
  IFS=$'\t' read -r exact_matches preferred_matches effective_matches provider_plan_matches <<< "$summary"
  if [[ "${exact_matches:-0}" -eq 0 ]]; then
    echo "validation_error=expected_preference_not_exercised scenario=$scenario request_id=$request_id expected_provider=$expected_provider" >&2
    return 1
  fi
  if [[ "${preferred_matches:-0}" -eq 0 ]]; then
    echo "validation_error=preferred_provider_mismatch scenario=$scenario request_id=$request_id expected_provider=$expected_provider" >&2
    return 1
  fi
  if [[ "${effective_matches:-0}" -eq 0 ]]; then
    echo "validation_error=effective_provider_mismatch scenario=$scenario request_id=$request_id expected_provider=$expected_provider" >&2
    return 1
  fi
  if [[ "${provider_plan_matches:-0}" -eq 0 ]]; then
    echo "validation_error=provider_plan_missing_expected scenario=$scenario request_id=$request_id expected_provider=$expected_provider" >&2
    return 1
  fi
}

validate_pinned_session() {
  local session_id="$1"
  local distinct_providers
  distinct_providers="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA -c "
    select count(distinct provider)
    from in_routing_events
    where org_id = '$INNIES_ORG_ID'
      and route_decision->>'openclaw_session_id' = '$session_id'
      and created_at >= now() - interval '1 day'
  ")"

  echo "session_guard session_id=$session_id distinct_providers=${distinct_providers:-0}"
  [[ "${distinct_providers:-0}" == "1" ]]
}

validate_pinned_selection_reason() {
  local session_id="$1"
  local mismatches
  mismatches="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA -c "
    select count(*)
    from in_routing_events
    where org_id = '$INNIES_ORG_ID'
      and route_decision->>'openclaw_session_id' = '$session_id'
      and created_at >= now() - interval '1 day'
      and coalesce(route_decision->>'provider_selection_reason', route_decision->>'reason', '') <> 'cli_provider_pinned'
  ")"

  echo "session_pin_reason_guard session_id=$session_id mismatches=${mismatches:-0}"
  [[ "${mismatches:-0}" == "0" ]]
}

validate_http_statuses() {
  local failed=0
  while IFS=$'\t' read -r scenario request_id status _provider_mode _model _expected_provider _headers _body; do
    if [[ "$status" -lt 200 || "$status" -gt 299 ]]; then
      echo "validation_error=http_status scenario=$scenario request_id=$request_id status=$status" >&2
      failed=1
    fi
  done < "$REQUESTS_FILE"
  [[ "$failed" -eq 0 ]]
}

PRIMARY_EXPECTED_PROVIDER="$(canonicalize_provider "${INNIES_EXPECTED_PREFERRED_PROVIDER:-anthropic}")"
PRIMARY_PREFERENCE_MODEL="${INNIES_PREFERENCE_MODEL:-$(model_for_provider "$PRIMARY_EXPECTED_PROVIDER")}"
PRIMARY_SECONDARY_TOKEN="${INNIES_BUYER_API_KEY_B:-}"
SECONDARY_EXPECTED_PROVIDER="${INNIES_SECONDARY_EXPECTED_PREFERRED_PROVIDER:-}"
if [[ -n "$SECONDARY_EXPECTED_PROVIDER" ]]; then
  SECONDARY_EXPECTED_PROVIDER="$(canonicalize_provider "$SECONDARY_EXPECTED_PROVIDER")"
fi
SECONDARY_PREFERENCE_MODEL=""
if [[ -n "$SECONDARY_EXPECTED_PROVIDER" ]]; then
  SECONDARY_PREFERENCE_MODEL="${INNIES_SECONDARY_PREFERENCE_MODEL:-$(model_for_provider "$SECONDARY_EXPECTED_PROVIDER")}"
fi

echo "== Provider preference check start =="
echo "time_utc=$RUN_TS preference_session_id=$PREFERENCE_SESSION_ID pinned_session_id=$PINNED_SESSION_ID"
echo "primary_expected_provider=$PRIMARY_EXPECTED_PROVIDER"
if [[ -n "$SECONDARY_EXPECTED_PROVIDER" ]]; then
  echo "secondary_expected_provider=$SECONDARY_EXPECTED_PROVIDER"
fi

PINNED_PROVIDER="${INNIES_PINNED_PROVIDER:-anthropic}"
if [[ -n "${INNIES_PINNED_MODEL:-}" ]]; then
  PINNED_MODEL="$INNIES_PINNED_MODEL"
elif [[ "$PINNED_PROVIDER" == "openai" || "$PINNED_PROVIDER" == "codex" ]] && [[ -n "${INNIES_MODEL_CODEX:-}" ]]; then
  PINNED_MODEL="$INNIES_MODEL_CODEX"
else
  PINNED_MODEL="$INNIES_MODEL_ANTHROPIC"
fi

echo "-- scenario 1: omitted-provider request (preference path) --"
send_proxy_request "preference_path" "$INNIES_BUYER_API_KEY" "__omit__" "$PRIMARY_PREFERENCE_MODEL" "false" "$PREFERENCE_SESSION_ID" "false" "$PRIMARY_EXPECTED_PROVIDER"

if [[ -n "$SECONDARY_EXPECTED_PROVIDER" ]]; then
  if [[ -z "$PRIMARY_SECONDARY_TOKEN" ]]; then
    echo "warning=secondary_preference_scenario_skipped reason=missing_INNIES_BUYER_API_KEY_B expected_provider=$SECONDARY_EXPECTED_PROVIDER"
  else
    echo "-- scenario 1b: omitted-provider request on second buyer key --"
    send_proxy_request "preference_path_secondary" "$PRIMARY_SECONDARY_TOKEN" "__omit__" "$SECONDARY_PREFERENCE_MODEL" "false" "$SECONDARY_PREFERENCE_SESSION_ID" "false" "$SECONDARY_EXPECTED_PROVIDER"
  fi
fi

echo "-- scenario 2: explicit-provider pinned request (session guard baseline) --"
send_proxy_request "pinned_first" "$INNIES_BUYER_API_KEY" "$PINNED_PROVIDER" "$PINNED_MODEL" "false" "$PINNED_SESSION_ID" "true" "$(canonicalize_provider "$PINNED_PROVIDER")"

echo "-- scenario 3: repeat pinned request in same session --"
send_proxy_request "pinned_second" "$INNIES_BUYER_API_KEY" "$PINNED_PROVIDER" "$PINNED_MODEL" "false" "$PINNED_SESSION_ID" "true" "$(canonicalize_provider "$PINNED_PROVIDER")"

if [[ -n "${DATABASE_URL:-}" && -n "${INNIES_ORG_ID:-}" ]] && command -v psql >/dev/null 2>&1; then
  echo "-- db evidence: request-level preference metadata --"
  while IFS=$'\t' read -r scenario request_id status _provider_mode _model _expected_provider _headers _body; do
    print_db_evidence "$scenario" "$request_id"
  done < "$REQUESTS_FILE"

  validate_status=0
  if ! validate_http_statuses; then
    validate_status=1
  fi
  while IFS=$'\t' read -r scenario request_id _status provider_mode _model expected_provider _headers _body; do
    if [[ "$provider_mode" == "__omit__" && "$expected_provider" != "<none>" ]]; then
      if ! validate_preference_metadata "$scenario" "$request_id" "$expected_provider"; then
        validate_status=1
      fi
    fi
  done < "$REQUESTS_FILE"
  if ! validate_pinned_session "$PINNED_SESSION_ID"; then
    echo "validation_error=session_provider_flip session_id=$PINNED_SESSION_ID" >&2
    validate_status=1
  fi
  if ! validate_pinned_selection_reason "$PINNED_SESSION_ID"; then
    echo "validation_error=session_pin_reason session_id=$PINNED_SESSION_ID" >&2
    validate_status=1
  fi
  if [[ "$validate_status" -ne 0 ]]; then
    echo "validation_result=failed" >&2
    echo "artifacts_dir=$TMP_DIR"
    exit 1
  fi
  echo "validation_result=passed"
else
  echo "-- db evidence skipped (set DATABASE_URL + INNIES_ORG_ID + psql) --"
  echo "warning=without_db_evidence_this_check_only_confirms_request_reachability_not_preference_metadata"
  if ! validate_http_statuses; then
    echo "validation_result=failed" >&2
    echo "artifacts_dir=$TMP_DIR"
    exit 1
  fi
  echo "validation_result=passed_reachability_only"
fi

echo "artifacts_dir=$TMP_DIR"
echo "== Provider preference check complete =="
