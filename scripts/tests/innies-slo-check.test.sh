#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
{"ttfbP95Ms":1000,"errorRate":0.01,"fallbackRate":0.05,"totalRequests":40}
200
JSON
    ;;
  *"/v1/admin/analytics/tokens/routing?window=24h")
    cat <<'JSON'
{"tokens":[
  {"fallbackCount":3,"totalAttempts":10},
  {"fallbackCount":2,"totalAttempts":10}
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
  echo "expected fallback line to use routing-derived 25% aggregate" >&2
  echo "$output" >&2
  exit 1
fi

if [[ "$fallback_line" != *"FLAG"* ]]; then
  echo "expected fallback line to remain flagged above 20%" >&2
  echo "$output" >&2
  exit 1
fi

if [[ "$output" != *"Fallback source: /v1/admin/analytics/tokens/routing per-token aggregate."* ]]; then
  echo "expected output to document the routing-derived fallback source" >&2
  echo "$output" >&2
  exit 1
fi

echo "PASS: innies-slo-check reports routing-derived fallback rate in the main SLO table"
