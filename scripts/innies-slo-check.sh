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

WINDOW="${1:-24h}"

if ! command -v jq >/dev/null 2>&1; then
  echo 'error: jq is required for this command' >&2
  exit 1
fi

# --- fetch system summary ---
system_response="$(curl -sS -w '\n%{http_code}' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "${BASE_URL%/}/v1/admin/analytics/system?window=${WINDOW}")"

system_status="$(printf '%s' "$system_response" | tail -n1)"
system_body="$(printf '%s' "$system_response" | sed '$d')"

if [[ "$system_status" != "200" ]]; then
  echo "error: /v1/admin/analytics/system returned HTTP $system_status" >&2
  echo "$system_body" >&2
  exit 1
fi

# --- fetch routing summary ---
routing_response="$(curl -sS -w '\n%{http_code}' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "${BASE_URL%/}/v1/admin/analytics/tokens/routing?window=${WINDOW}")"

routing_status="$(printf '%s' "$routing_response" | tail -n1)"
routing_body="$(printf '%s' "$routing_response" | sed '$d')"

if [[ "$routing_status" != "200" ]]; then
  echo "error: /v1/admin/analytics/tokens/routing returned HTTP $routing_status" >&2
  echo "$routing_body" >&2
  exit 1
fi

# --- extract metrics ---
ttfb_p95="$(printf '%s' "$system_body" | jq -r '.ttfbP95Ms // empty')"
error_rate="$(printf '%s' "$system_body" | jq -r '.errorRate // 0')"
system_fallback_rate="$(printf '%s' "$system_body" | jq -r '.fallbackRate // 0')"
total_requests="$(printf '%s' "$system_body" | jq -r '.totalRequests // 0')"

# Compute fallback rate from routing tokens as cross-check
routing_fallback_rate="$(printf '%s' "$routing_body" | jq -r '
  [.tokens[] | {f: (.fallbackCount // 0), t: (.totalAttempts // 0)}]
  | {total_fallbacks: (map(.f) | add // 0), total_attempts: (map(.t) | add // 0)}
  | if .total_attempts == 0 then 0
    else (.total_fallbacks / .total_attempts)
    end')"
routing_fallback_display="$(jq -n --argjson v "$routing_fallback_rate" '($v * 100 * 100 | round) / 100 | tostring + "%"')"

# Use system-level fallback rate as primary
fallback_rate="$system_fallback_rate"

# Derive timeout rate and success rate from errorRate
# errorRate encompasses timeouts + errors; the API does not separate them
timeout_rate="$error_rate"
success_rate="$(printf '%s' "$error_rate" | jq -n --arg er "$error_rate" '(1 - ($er | tonumber))')"

# --- SLO targets ---
# NOTE: timeout_rate and success_rate are both derived from the single errorRate
# metric returned by the API (errorRate encompasses timeouts + errors). The API
# does not yet expose separate tracking, so success_rate = 1 - errorRate and
# timeout_rate = errorRate. With thresholds ≤2% and ≥95%, the success check can
# never fail independently of the timeout check.
SLO_TTFB_P95=8000
SLO_TIMEOUT_RATE=0.02
SLO_SUCCESS_RATE=0.95
SLO_FALLBACK_RATE=0.20

# --- evaluate pass/fail ---
exit_code=0

if [[ -z "$ttfb_p95" ]]; then
  ttfb_pass="N/A"
  ttfb_display="no data"
else
  if jq -n --argjson v "$ttfb_p95" --argjson t "$SLO_TTFB_P95" '$v <= $t' | grep -q true; then
    ttfb_pass="PASS"
  else
    ttfb_pass="FAIL"
    exit_code=1
  fi
  ttfb_display="${ttfb_p95} ms"
fi

if jq -n --argjson v "$timeout_rate" --argjson t "$SLO_TIMEOUT_RATE" '$v <= $t' | grep -q true; then
  timeout_pass="PASS"
else
  timeout_pass="FAIL"
  exit_code=1
fi
timeout_display="$(jq -n --argjson v "$timeout_rate" '($v * 100 * 100 | round) / 100 | tostring + "%"')"

if jq -n --argjson v "$success_rate" --argjson t "$SLO_SUCCESS_RATE" '$v >= $t' | grep -q true; then
  success_pass="PASS"
else
  success_pass="FAIL"
  exit_code=1
fi
success_display="$(jq -n --argjson v "$success_rate" '($v * 100 * 100 | round) / 100 | tostring + "%"')"

fallback_flag="OK"
if jq -n --argjson v "$fallback_rate" --argjson t "$SLO_FALLBACK_RATE" '$v > $t' | grep -q true; then
  fallback_flag="FLAG"
fi
fallback_display="$(jq -n --argjson v "$fallback_rate" '($v * 100 * 100 | round) / 100 | tostring + "%"')"

# --- output ---
echo ""
echo "SLO Check (window: ${WINDOW}, requests: ${total_requests})"
echo "================================================================"
printf '%-28s %-12s %-12s %s\n' "Metric" "Target" "Actual" "Result"
printf '%-28s %-12s %-12s %s\n' "---" "---" "---" "---"
printf '%-28s %-12s %-12s %s\n' "First-byte latency p95" "<= 8000 ms" "$ttfb_display" "$ttfb_pass"
printf '%-28s %-12s %-12s %s\n' "Timeout rate" "<= 2.0%" "$timeout_display" "$timeout_pass"
printf '%-28s %-12s %-12s %s\n' "Tool-loop success rate" ">= 95.0%" "$success_display" "$success_pass"
printf '%-28s %-12s %-12s %s\n' "Fallback rate" "flag > 20%" "$fallback_display" "$fallback_flag"
echo "================================================================"
echo "* timeout_rate and success_rate are derived from the same errorRate metric."
echo "  The API does not yet separate timeouts from other errors."
echo "* Fallback rate source: /v1/admin/analytics/system whole-population metric."
echo "* Routing fallback context: ${routing_fallback_display} from attributed token events only."
echo "  Unattributed routing events are excluded from /v1/admin/analytics/tokens/routing."

if [[ "$exit_code" -eq 0 ]]; then
  echo "All SLOs passed."
else
  echo "One or more SLOs failed."
fi

exit "$exit_code"
