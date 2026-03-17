#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="${SCRIPT_DIR}/${SCRIPT_PATH}"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cat > "${tmp_dir}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

scenario="${INNIES_SLO_CHECK_TEST_SCENARIO:-mixed_unattributed}"
url="${*: -1}"

case "$url" in
  *"/v1/admin/analytics/system?window=24h")
    cat <<'JSON'
{"ttfbP95Ms":1000,"errorRate":0.01,"fallbackRate":0.25,"totalRequests":4}
200
JSON
    ;;
  *"/v1/admin/analytics/tokens/routing?window=24h")
    case "$scenario" in
      mixed_unattributed)
        cat <<'JSON'
{"tokens":[
  {"fallbackCount":0,"totalAttempts":3}
]}
200
JSON
        ;;
      routing_unavailable)
        cat <<'JSON'
{"error":"routing summary unavailable"}
500
JSON
        ;;
      routing_transport_failure)
        echo "curl: (7) failed to connect to analytics routing endpoint" >&2
        exit 7
        ;;
      *)
        echo "unexpected test scenario: $scenario" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "unexpected curl url: $url" >&2
    exit 1
    ;;
esac
EOF
chmod +x "${tmp_dir}/curl"

run_slo_check() {
  local scenario="$1"
  local output_var="$2"
  local status_var="$3"
  local output
  local status

  set +e
  output="$(
    PATH="${tmp_dir}:$PATH" \
    INNIES_ADMIN_API_KEY="admin-token" \
    INNIES_ENV_FILE="${tmp_dir}/missing.env" \
    INNIES_SLO_CHECK_TEST_SCENARIO="$scenario" \
    bash "${ROOT_DIR}/scripts/innies-slo-check.sh" 2>&1
  )"
  status=$?
  set -e

  printf -v "$output_var" '%s' "$output"
  printf -v "$status_var" '%s' "$status"
}

run_slo_check "mixed_unattributed" mixed_output mixed_status

if [[ "$mixed_status" -ne 0 ]]; then
  echo "expected mixed unattributed scenario to keep the main report available" >&2
  echo "$mixed_output" >&2
  exit 1
fi

fallback_line="$(printf '%s\n' "$mixed_output" | awk '$1 == "Fallback" && $2 == "rate" { print; exit }')"

if [[ "$fallback_line" != *"25%"* ]]; then
  echo "expected fallback line to keep the whole-population 25% rate" >&2
  echo "$mixed_output" >&2
  exit 1
fi

if [[ "$fallback_line" != *"FLAG"* ]]; then
  echo "expected fallback line to remain flagged above 20%" >&2
  echo "$mixed_output" >&2
  exit 1
fi

if [[ "$mixed_output" != *"Fallback source: /v1/admin/analytics/system whole-population fallback rate."* ]]; then
  echo "expected output to identify the system endpoint as the main fallback source" >&2
  echo "$mixed_output" >&2
  exit 1
fi

if [[ "$mixed_output" != *"Routing cross-check below is per-token-only and may exclude unattributed events."* ]]; then
  echo "expected output to warn that the routing cross-check is subset-only" >&2
  echo "$mixed_output" >&2
  exit 1
fi

if [[ "$mixed_output" != *"(routing cross-check: attributed per-token aggregate fallback rate = 0%)"* ]]; then
  echo "expected output to show the attributed routing cross-check separately" >&2
  echo "$mixed_output" >&2
  exit 1
fi

run_slo_check "routing_unavailable" unavailable_output unavailable_status

if [[ "$unavailable_status" -ne 0 ]]; then
  echo "expected routing-unavailable scenario to keep the main report available" >&2
  echo "$unavailable_output" >&2
  exit 1
fi

unavailable_fallback_line="$(printf '%s\n' "$unavailable_output" | awk '$1 == "Fallback" && $2 == "rate" { print; exit }')"

if [[ "$unavailable_fallback_line" != *"25%"* || "$unavailable_fallback_line" != *"FLAG"* ]]; then
  echo "expected routing-unavailable scenario to keep the system fallback row truthful and flagged" >&2
  echo "$unavailable_output" >&2
  exit 1
fi

if [[ "$unavailable_output" != *"(routing cross-check: unavailable; /v1/admin/analytics/tokens/routing returned HTTP 500)"* ]]; then
  echo "expected routing-unavailable scenario to mark the cross-check unavailable" >&2
  echo "$unavailable_output" >&2
  exit 1
fi

run_slo_check "routing_transport_failure" transport_output transport_status

if [[ "$transport_status" -ne 0 ]]; then
  echo "expected routing transport failure to keep the main report available" >&2
  echo "$transport_output" >&2
  exit 1
fi

transport_fallback_line="$(printf '%s\n' "$transport_output" | awk '$1 == "Fallback" && $2 == "rate" { print; exit }')"

if [[ "$transport_fallback_line" != *"25%"* || "$transport_fallback_line" != *"FLAG"* ]]; then
  echo "expected routing transport failure to keep the system fallback row truthful and flagged" >&2
  echo "$transport_output" >&2
  exit 1
fi

if [[ "$transport_output" != *"(routing cross-check: unavailable; /v1/admin/analytics/tokens/routing request failed: curl: (7) failed to connect to analytics routing endpoint)"* ]]; then
  echo "expected routing transport failure to mark the cross-check unavailable with the curl error" >&2
  echo "$transport_output" >&2
  exit 1
fi

echo "PASS: innies-slo-check keeps fallback truthful when routing misses unattributed events"
echo "PASS: innies-slo-check keeps the main report available when routing cross-check is unavailable"
echo "PASS: innies-slo-check keeps the main report available when the routing request fails"
