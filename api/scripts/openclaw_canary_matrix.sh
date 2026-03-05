#!/usr/bin/env bash
set -euo pipefail

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
MODEL="${MODEL:-${INNIES_MODEL_ANTHROPIC:-}}"
TOKEN_A="${TOKEN_A:-${INNIES_BUYER_API_KEY:-}}"
TOKEN_B="${TOKEN_B:-${INNIES_BUYER_API_KEY_B:-}}"

if [[ -z "$MODEL" ]]; then
  echo "missing MODEL or INNIES_MODEL_ANTHROPIC" >&2
  exit 1
fi
if [[ -z "$TOKEN_A" ]]; then
  echo "missing TOKEN_A or INNIES_BUYER_API_KEY" >&2
  exit 1
fi

run_case() {
  local token_label="$1"
  local token="$2"
  local thinking_mode="$3"
  local rid="canary_${token_label}_${thinking_mode}_$(date +%s)"
  local headers_file="${TMPDIR:-/tmp}/innies_openclaw_${rid}_headers.txt"
  local body_file="${TMPDIR:-/tmp}/innies_openclaw_${rid}_body.txt"

  local thinking_json=""
  local max_tokens=128
  if [[ "$thinking_mode" == "on" ]]; then
    thinking_json=',"thinking":{"type":"enabled","budget_tokens":1024}'
    max_tokens=2048
  fi

  echo "---- token=${token_label} thinking=${thinking_mode} rid=${rid} ----"
  local status
  status="$(curl -sS -D "$headers_file" -o "$body_file" -w "%{http_code}" -X POST "${API_URL}/v1/messages" \
    -H "Authorization: Bearer ${token}" \
    -H "x-request-id: ${rid}" \
    -H "Content-Type: application/json" \
    -H "anthropic-version: 2023-06-01" \
    --data-binary @- <<JSON
{
  "model": "${MODEL}",
  "max_tokens": ${max_tokens},
  "stream": false,
  "messages": [{"role":"user","content":"reply with one short word"}]
  ${thinking_json}
}
JSON
)"
  sed 's/\r$//' "$headers_file"
  cat "$body_file"
  echo
  if [[ "$status" == "404" ]] && grep -q '"code":"not_found"' "$body_file"; then
    echo "check_status=skipped_compat_endpoint_disabled rid=${rid}"
    return 2
  fi
  echo "query:"
  echo "SELECT request_id, attempt_no, upstream_status, error_code, created_at"
  echo "FROM in_routing_events WHERE request_id='${rid}' ORDER BY attempt_no;"
  echo
}

echo "== OpenClaw matrix check start =="
echo "api_url=${API_URL}"
echo "model=${MODEL}"

run_case_or_exit() {
  local token_label="$1"
  local token="$2"
  local thinking_mode="$3"
  local rc=0
  set +e
  run_case "$token_label" "$token" "$thinking_mode"
  rc=$?
  set -e
  if [[ "$rc" -eq 2 ]]; then
    echo "== OpenClaw matrix check complete =="
    exit 0
  fi
  if [[ "$rc" -ne 0 ]]; then
    exit "$rc"
  fi
}

run_case_or_exit "a" "${TOKEN_A}" "off"
run_case_or_exit "a" "${TOKEN_A}" "on"

if [[ -z "$TOKEN_B" ]]; then
  echo "check_status=skipped_token_b_cases reason=missing_TOKEN_B_or_INNIES_BUYER_API_KEY_B"
  echo "== OpenClaw matrix check complete =="
  exit 0
fi

run_case_or_exit "b" "${TOKEN_B}" "off"
run_case_or_exit "b" "${TOKEN_B}" "on"
echo "check_status=completed"
echo "== OpenClaw matrix check complete =="
