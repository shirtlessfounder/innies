#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${INNIES_BASE_URL:-}" ]]; then
  echo "missing INNIES_BASE_URL" >&2
  exit 1
fi
if [[ -z "${MODEL:-}" ]]; then
  echo "missing MODEL" >&2
  exit 1
fi
if [[ -z "${TOKEN_A:-}" || -z "${TOKEN_B:-}" ]]; then
  echo "missing TOKEN_A or TOKEN_B" >&2
  exit 1
fi

run_case() {
  local token_label="$1"
  local token="$2"
  local thinking_mode="$3"
  local rid="canary_${token_label}_${thinking_mode}_$(date +%s)"

  local thinking_json=""
  local max_tokens=128
  if [[ "$thinking_mode" == "on" ]]; then
    thinking_json=',"thinking":{"type":"enabled","budget_tokens":1024}'
    max_tokens=2048
  fi

  echo "---- token=${token_label} thinking=${thinking_mode} rid=${rid} ----"
  curl -sS -i -X POST "${INNIES_BASE_URL%/}/v1/messages" \
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
  echo
  echo "query:"
  echo "SELECT request_id, attempt_no, upstream_status, error_code, created_at"
  echo "FROM in_routing_events WHERE request_id='${rid}' ORDER BY attempt_no;"
  echo
}

run_case "a" "${TOKEN_A}" "off"
run_case "a" "${TOKEN_A}" "on"
run_case "b" "${TOKEN_B}" "off"
run_case "b" "${TOKEN_B}" "on"
