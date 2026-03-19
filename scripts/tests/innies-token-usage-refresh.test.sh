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

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  [[ "$haystack" == *"$needle"* ]] || fail "missing expected text: $needle"
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

: > "${tmp_dir}/test.env"

cat > "${tmp_dir}/psql" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

sql="$(cat)"

if [[ "$sql" == *"provider in ('anthropic', 'openai', 'codex')"* ]]; then
  printf 'anthropic-id\x1fclaude-primary\x1fanthropic\x1factive\x1f2026-03-19T12:00:00Z\n'
  printf 'openai-id\x1fopenai-primary\x1fopenai\x1factive\x1f2026-03-19T11:00:00Z\n'
  printf 'codex-id\x1fcodex-legacy\x1fcodex\x1factive\x1f2026-03-19T10:00:00Z\n'
else
  printf 'anthropic-id\x1fclaude-primary\x1fanthropic\x1factive\x1f2026-03-19T12:00:00Z\n'
  printf 'openai-id\x1fopenai-primary\x1fopenai\x1factive\x1f2026-03-19T11:00:00Z\n'
fi
EOF
chmod +x "${tmp_dir}/psql"

cat > "${tmp_dir}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

headers_file=""
body_file=""
url=""

while (($# > 0)); do
  case "$1" in
    -D|-o|-w|-X|-H|--data-binary)
      if [[ "$1" == "-D" ]]; then
        headers_file="$2"
      elif [[ "$1" == "-o" ]]; then
        body_file="$2"
      fi
      shift 2
      ;;
    -sS)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done

printf '%s\n' "$url" > "${TEST_TMP_DIR}/curl-url"
cat > "$headers_file" <<'HEADERS'
HTTP/1.1 200 OK
Content-Type: application/json

HEADERS
cat > "$body_file" <<'JSON'
{"refreshOk":true,"provider":"codex","debugLabel":"codex-legacy","status":"active","reason":"ok","upstreamStatus":200,"snapshot":{"fiveHourUsedPercent":12,"fiveHourResetsAt":"2026-03-19T12:00:00Z","fiveHourContributionCapExhausted":false,"sevenDayUsedPercent":34,"sevenDayResetsAt":"2026-03-25T12:00:00Z","sevenDayContributionCapExhausted":false},"stateSyncErrors":[]}
JSON
printf '200'
EOF
chmod +x "${tmp_dir}/curl"

if ! output="$(
  printf '3\n\n' | \
    PATH="${tmp_dir}:$PATH" \
    TEST_TMP_DIR="$tmp_dir" \
    INNIES_ADMIN_API_KEY="admin-token" \
    DATABASE_URL="postgresql://example.invalid/innies" \
    INNIES_ENV_FILE="${tmp_dir}/test.env" \
    bash "${ROOT_DIR}/scripts/innies-token-usage-refresh.sh" 2>&1
)"; then
  fail "expected script to accept numbered codex selection, got:\n${output}"
fi

assert_contains "$output" '3) codex-legacy (codex, active) id=codex-id updatedAt=2026-03-19T10:00:00Z'
assert_contains "$output" 'tokenCredentialId: codex-id'
assert_contains "$output" 'credential: codex-legacy (codex)'

curl_url="$(cat "${tmp_dir}/curl-url")"
[[ "$curl_url" == 'http://localhost:4010/v1/admin/token-credentials/codex-id/provider-usage-refresh' ]] || \
  fail "unexpected provider-usage refresh URL: $curl_url"

echo 'PASS: innies-token-usage-refresh includes legacy codex credentials in numbered selection'
