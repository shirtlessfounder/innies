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

url="${*: -1}"

case "$url" in
  *"/v1/admin/analytics/system?window=24h")
    cat <<'JSON'
{"ttfbP95Ms":1000,"errorRate":0.01,"fallbackRate":0.25,"totalRequests":4}
200
JSON
    ;;
  *"/v1/admin/analytics/tokens/routing?window=24h")
    cat <<'JSON'
{"tokens":[
  {"fallbackCount":0,"totalAttempts":3}
]}
200
JSON
    ;;
  *)
    echo "unexpected curl url: $url" >&2
    exit 1
    ;;
esac
EOF
chmod +x "${tmp_dir}/curl"

output="$(
  PATH="${tmp_dir}:$PATH" \
  INNIES_ADMIN_API_KEY="admin-token" \
  INNIES_ENV_FILE="${tmp_dir}/missing.env" \
  bash "${ROOT_DIR}/scripts/innies-slo-check.sh"
)"

fallback_line="$(printf '%s\n' "$output" | awk '$1 == "Fallback" && $2 == "rate" { print; exit }')"

if [[ "$fallback_line" != *"25%"* ]]; then
  echo "expected fallback line to keep the whole-population 25% rate" >&2
  echo "$output" >&2
  exit 1
fi

if [[ "$fallback_line" != *"FLAG"* ]]; then
  echo "expected fallback line to remain flagged above 20%" >&2
  echo "$output" >&2
  exit 1
fi

if [[ "$output" != *"Fallback source: /v1/admin/analytics/system whole-population fallback rate."* ]]; then
  echo "expected output to identify the system endpoint as the main fallback source" >&2
  echo "$output" >&2
  exit 1
fi

if [[ "$output" != *"Routing cross-check below is per-token-only and may exclude unattributed events."* ]]; then
  echo "expected output to warn that the routing cross-check is subset-only" >&2
  echo "$output" >&2
  exit 1
fi

if [[ "$output" != *"(routing cross-check: attributed per-token aggregate fallback rate = 0%)"* ]]; then
  echo "expected output to show the attributed routing cross-check separately" >&2
  echo "$output" >&2
  exit 1
fi

echo "PASS: innies-slo-check keeps fallback truthful when routing misses unattributed events"

cat > "${tmp_dir}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

url="${*: -1}"

case "$url" in
  *"/v1/admin/analytics/system?window=24h")
    cat <<'JSON'
{"ttfbP95Ms":1000,"errorRate":0.01,"fallbackRate":0.25,"totalRequests":4}
200
JSON
    ;;
  *"/v1/admin/analytics/tokens/routing?window=24h")
    cat <<'JSON'
{"error":"routing unavailable"}
500
JSON
    ;;
  *)
    echo "unexpected curl url: $url" >&2
    exit 1
    ;;
esac
EOF
chmod +x "${tmp_dir}/curl"

if ! unavailable_output="$(
  PATH="${tmp_dir}:$PATH" \
  INNIES_ADMIN_API_KEY="admin-token" \
  INNIES_ENV_FILE="${tmp_dir}/missing.env" \
  bash "${ROOT_DIR}/scripts/innies-slo-check.sh"
)"; then
  echo "expected script to keep the main SLO report running when routing cross-check is unavailable" >&2
  exit 1
fi

unavailable_fallback_line="$(printf '%s\n' "$unavailable_output" | awk '$1 == "Fallback" && $2 == "rate" { print; exit }')"

if [[ "$unavailable_fallback_line" != *"25%"* || "$unavailable_fallback_line" != *"FLAG"* ]]; then
  echo "expected fallback line to stay on the system summary when routing is unavailable" >&2
  echo "$unavailable_output" >&2
  exit 1
fi

if [[ "$unavailable_output" != *"(routing cross-check: unavailable"* ]]; then
  echo "expected output to mark the routing cross-check as unavailable instead of aborting" >&2
  echo "$unavailable_output" >&2
  exit 1
fi

echo "PASS: innies-slo-check keeps the main SLO report usable when routing cross-check is unavailable"
