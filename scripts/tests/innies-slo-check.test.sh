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
{"tokens":null}
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

if ! malformed_output="$(
  PATH="${tmp_dir}:$PATH" \
  INNIES_ADMIN_API_KEY="admin-token" \
  INNIES_ENV_FILE="${tmp_dir}/missing.env" \
  bash "${ROOT_DIR}/scripts/innies-slo-check.sh"
)"; then
  echo "expected script to keep the main SLO report running when the routing cross-check body is malformed" >&2
  exit 1
fi

malformed_fallback_line="$(printf '%s\n' "$malformed_output" | awk '$1 == "Fallback" && $2 == "rate" { print; exit }')"

if [[ "$malformed_fallback_line" != *"25%"* || "$malformed_fallback_line" != *"FLAG"* ]]; then
  echo "expected fallback line to stay on the system summary when the routing body is malformed" >&2
  echo "$malformed_output" >&2
  exit 1
fi

if [[ "$malformed_output" != *"(routing cross-check: unavailable - /v1/admin/analytics/tokens/routing returned malformed data)"* ]]; then
  echo "expected malformed routing data to be treated as an unavailable routing cross-check" >&2
  echo "$malformed_output" >&2
  exit 1
fi

echo "PASS: innies-slo-check keeps the main SLO report usable when routing returns malformed data"

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
    echo "curl: (7) Failed to connect" >&2
    exit 7
    ;;
  *)
    echo "unexpected curl url: $url" >&2
    exit 1
    ;;
esac
EOF
chmod +x "${tmp_dir}/curl"

if ! transport_failure_output="$(
  PATH="${tmp_dir}:$PATH" \
  INNIES_ADMIN_API_KEY="admin-token" \
  INNIES_ENV_FILE="${tmp_dir}/missing.env" \
  bash "${ROOT_DIR}/scripts/innies-slo-check.sh"
)"; then
  echo "expected script to keep the main SLO report running when the routing request itself fails" >&2
  exit 1
fi

transport_failure_fallback_line="$(printf '%s\n' "$transport_failure_output" | awk '$1 == "Fallback" && $2 == "rate" { print; exit }')"

if [[ "$transport_failure_fallback_line" != *"25%"* || "$transport_failure_fallback_line" != *"FLAG"* ]]; then
  echo "expected fallback line to stay on the system summary when the routing request fails" >&2
  echo "$transport_failure_output" >&2
  exit 1
fi

if [[ "$transport_failure_output" != *"(routing cross-check: unavailable - /v1/admin/analytics/tokens/routing request failed)"* ]]; then
  echo "expected output to show a transport failure as an unavailable routing cross-check" >&2
  echo "$transport_failure_output" >&2
  exit 1
fi

echo "PASS: innies-slo-check keeps the main SLO report usable when the routing request fails"

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
{"tokens":[1]}
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

if ! malformed_array_output="$(
  PATH="${tmp_dir}:$PATH" \
  INNIES_ADMIN_API_KEY="admin-token" \
  INNIES_ENV_FILE="${tmp_dir}/missing.env" \
  bash "${ROOT_DIR}/scripts/innies-slo-check.sh"
)"; then
  echo "expected script to keep the main SLO report running when routing tokens contain malformed entries" >&2
  exit 1
fi

malformed_array_fallback_line="$(printf '%s\n' "$malformed_array_output" | awk '$1 == "Fallback" && $2 == "rate" { print; exit }')"

if [[ "$malformed_array_fallback_line" != *"25%"* || "$malformed_array_fallback_line" != *"FLAG"* ]]; then
  echo "expected fallback line to stay on the system summary when routing tokens contain malformed entries" >&2
  echo "$malformed_array_output" >&2
  exit 1
fi

if [[ "$malformed_array_output" != *"(routing cross-check: unavailable - /v1/admin/analytics/tokens/routing returned malformed data)"* ]]; then
  echo "expected malformed token entries to be treated as an unavailable routing cross-check" >&2
  echo "$malformed_array_output" >&2
  exit 1
fi

echo "PASS: innies-slo-check keeps the main SLO report usable when routing tokens contain malformed entries"

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
{"tokens":[{"fallbackCount":1}]}
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

if ! partially_malformed_output="$(
  PATH="${tmp_dir}:$PATH" \
  INNIES_ADMIN_API_KEY="admin-token" \
  INNIES_ENV_FILE="${tmp_dir}/missing.env" \
  bash "${ROOT_DIR}/scripts/innies-slo-check.sh"
)"; then
  echo "expected script to keep the main SLO report running when routing tokens are missing required numeric fields" >&2
  exit 1
fi

partially_malformed_fallback_line="$(printf '%s\n' "$partially_malformed_output" | awk '$1 == "Fallback" && $2 == "rate" { print; exit }')"

if [[ "$partially_malformed_fallback_line" != *"25%"* || "$partially_malformed_fallback_line" != *"FLAG"* ]]; then
  echo "expected fallback line to stay on the system summary when routing token entries are partially malformed" >&2
  echo "$partially_malformed_output" >&2
  exit 1
fi

if [[ "$partially_malformed_output" != *"(routing cross-check: unavailable - /v1/admin/analytics/tokens/routing returned malformed data)"* ]]; then
  echo "expected partially malformed token entries to be treated as an unavailable routing cross-check" >&2
  echo "$partially_malformed_output" >&2
  exit 1
fi

echo "PASS: innies-slo-check keeps the main SLO report usable when routing token entries are missing required numeric fields"

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
{"tokens":[{"fallbackCount":3,"totalAttempts":2}]}
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

if ! impossible_numeric_output="$(
  PATH="${tmp_dir}:$PATH" \
  INNIES_ADMIN_API_KEY="admin-token" \
  INNIES_ENV_FILE="${tmp_dir}/missing.env" \
  bash "${ROOT_DIR}/scripts/innies-slo-check.sh"
)"; then
  echo "expected script to keep the main SLO report running when routing token rows are numerically impossible" >&2
  exit 1
fi

impossible_numeric_fallback_line="$(printf '%s\n' "$impossible_numeric_output" | awk '$1 == "Fallback" && $2 == "rate" { print; exit }')"

if [[ "$impossible_numeric_fallback_line" != *"25%"* || "$impossible_numeric_fallback_line" != *"FLAG"* ]]; then
  echo "expected fallback line to stay on the system summary when routing token rows are numerically impossible" >&2
  echo "$impossible_numeric_output" >&2
  exit 1
fi

if [[ "$impossible_numeric_output" != *"(routing cross-check: unavailable - /v1/admin/analytics/tokens/routing returned malformed data)"* ]]; then
  echo "expected numerically impossible routing token rows to be treated as an unavailable routing cross-check" >&2
  echo "$impossible_numeric_output" >&2
  exit 1
fi

echo "PASS: innies-slo-check keeps the main SLO report usable when routing token rows are numerically impossible"

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
{"tokens":[{"fallbackCount":-1,"totalAttempts":2}]}
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

if ! negative_counts_output="$(
  PATH="${tmp_dir}:$PATH" \
  INNIES_ADMIN_API_KEY="admin-token" \
  INNIES_ENV_FILE="${tmp_dir}/missing.env" \
  bash "${ROOT_DIR}/scripts/innies-slo-check.sh"
)"; then
  echo "expected script to keep the main SLO report running when routing token counts are negative" >&2
  exit 1
fi

negative_counts_fallback_line="$(printf '%s\n' "$negative_counts_output" | awk '$1 == "Fallback" && $2 == "rate" { print; exit }')"

if [[ "$negative_counts_fallback_line" != *"25%"* || "$negative_counts_fallback_line" != *"FLAG"* ]]; then
  echo "expected fallback line to stay on the system summary when routing token counts are negative" >&2
  echo "$negative_counts_output" >&2
  exit 1
fi

if [[ "$negative_counts_output" != *"(routing cross-check: unavailable - /v1/admin/analytics/tokens/routing returned malformed data)"* ]]; then
  echo "expected negative token counts to be treated as an unavailable routing cross-check" >&2
  echo "$negative_counts_output" >&2
  exit 1
fi

echo "PASS: innies-slo-check keeps the main SLO report usable when routing token counts are negative"

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
{"tokens":[{"fallbackCount":0,"totalAttempts":-1}]}
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

if ! negative_attempts_output="$(
  PATH="${tmp_dir}:$PATH" \
  INNIES_ADMIN_API_KEY="admin-token" \
  INNIES_ENV_FILE="${tmp_dir}/missing.env" \
  bash "${ROOT_DIR}/scripts/innies-slo-check.sh"
)"; then
  echo "expected script to keep the main SLO report running when routing totalAttempts is negative" >&2
  exit 1
fi

negative_attempts_fallback_line="$(printf '%s\n' "$negative_attempts_output" | awk '$1 == "Fallback" && $2 == "rate" { print; exit }')"

if [[ "$negative_attempts_fallback_line" != *"25%"* || "$negative_attempts_fallback_line" != *"FLAG"* ]]; then
  echo "expected fallback line to stay on the system summary when routing totalAttempts is negative" >&2
  echo "$negative_attempts_output" >&2
  exit 1
fi

if [[ "$negative_attempts_output" != *"(routing cross-check: unavailable - /v1/admin/analytics/tokens/routing returned malformed data)"* ]]; then
  echo "expected negative totalAttempts to be treated as an unavailable routing cross-check" >&2
  echo "$negative_attempts_output" >&2
  exit 1
fi

echo "PASS: innies-slo-check keeps the main SLO report usable when routing totalAttempts is negative"
