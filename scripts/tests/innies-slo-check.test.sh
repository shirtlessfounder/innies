#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="${ROOT_DIR}/scripts/innies-slo-check.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cat >"${tmp_dir}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

url="${@: -1}"

if [[ "$url" == *"/v1/admin/analytics/system?window=24h" ]]; then
  printf '%s\n%s\n' '{"ttfbP95Ms":5000,"errorRate":0.01,"fallbackRate":0.01,"totalRequests":100}' "200"
  exit 0
fi

if [[ "$url" == *"/v1/admin/analytics/tokens/routing?window=24h" ]]; then
  printf '%s\n%s\n' '{"tokens":[{"fallbackCount":30,"totalAttempts":100}]}' "200"
  exit 0
fi

printf 'unexpected curl URL: %s\n' "$url" >&2
exit 1
EOF

chmod +x "${tmp_dir}/curl"

set +e
output="$(
  PATH="${tmp_dir}:$PATH" \
  INNIES_ADMIN_API_KEY=test-admin-token \
  INNIES_BASE_URL=http://stub.invalid \
  bash "$SCRIPT_PATH" 2>&1
)"
status=$?
set -e

if [[ "$status" -ne 0 ]]; then
  printf 'expected exit 0, got %s\n%s\n' "$status" "$output" >&2
  exit 1
fi

if ! printf '%s\n' "$output" | grep -Eq 'Fallback rate[[:space:]]+flag > 20%[[:space:]]+"?30%"?[[:space:]]+FLAG'; then
  printf 'expected fallback row to use routing-derived 30%% and FLAG\n%s\n' "$output" >&2
  exit 1
fi

if printf '%s\n' "$output" | grep -Eq 'Fallback rate[[:space:]]+flag > 20%[[:space:]]+"?1%"?[[:space:]]+OK'; then
  printf 'fallback row incorrectly used system fallbackRate\n%s\n' "$output" >&2
  exit 1
fi

printf 'PASS: fallback row uses routing-derived aggregate\n'
