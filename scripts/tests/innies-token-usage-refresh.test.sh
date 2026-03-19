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

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  [[ "$haystack" != *"$needle"* ]] || fail "unexpected text present: $needle"
}

make_openai_oauth_token() {
  node --input-type=module - "$1" <<'EOF'
import process from 'node:process';

const expiry = process.argv[2];
const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8')
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/g, '');

const token = [
  encode({ alg: 'none', typ: 'JWT' }),
  encode({
    iss: 'https://auth.openai.com',
    aud: ['https://api.openai.com/v1'],
    client_id: 'app_test_client',
    exp: Math.floor(new Date(expiry).getTime() / 1000),
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct_test'
    }
  }),
  'sig'
].join('.');

process.stdout.write(token);
EOF
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

sell_secret="$(node --input-type=module -e "process.stdout.write(Buffer.alloc(32, 7).toString('base64'))")"
openai_token="$(make_openai_oauth_token '2026-03-20T15:49:35.000Z')"
codex_token="$(make_openai_oauth_token '2026-03-21T15:49:35.000Z')"
unsupported_token='sk-proj-not-supported-here'

anthropic_token_b64="$(printf 'sk-ant-oat01-live' | base64 | tr -d '\n')"
openai_token_b64="$(printf '%s' "$openai_token" | base64 | tr -d '\n')"
codex_token_b64="$(printf '%s' "$codex_token" | base64 | tr -d '\n')"
unsupported_token_b64="$(printf '%s' "$unsupported_token" | base64 | tr -d '\n')"

cat > "${tmp_dir}/test.env" <<EOF
SELLER_SECRET_ENC_KEY_B64=${sell_secret}
EOF

cat > "${tmp_dir}/psql" <<EOF
#!/usr/bin/env bash
set -euo pipefail

cat >/dev/null
printf 'anthropic-id\x1fclaude-primary\x1fanthropic\x1factive\x1f2026-03-19T12:00:00Z\x1fbearer\x1f${anthropic_token_b64}\n'
printf 'openai-id\x1fopenai-primary\x1fopenai\x1factive\x1f2026-03-19T11:00:00Z\x1fbearer\x1f${openai_token_b64}\n'
printf 'unsupported-id\x1fopenai-api-key\x1fopenai\x1factive\x1f2026-03-19T10:30:00Z\x1fbearer\x1f${unsupported_token_b64}\n'
printf 'codex-id\x1fcodex-session\x1fcodex\x1factive\x1f2026-03-19T10:00:00Z\x1fbearer\x1f${codex_token_b64}\n'
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
{"refreshOk":true,"provider":"codex","debugLabel":"codex-session","status":"active","reason":"ok","upstreamStatus":200,"snapshot":{"fiveHourUsedPercent":12,"fiveHourResetsAt":"2026-03-19T12:00:00Z","fiveHourContributionCapExhausted":null,"sevenDayUsedPercent":34,"sevenDayResetsAt":"2026-03-25T12:00:00Z","sevenDayContributionCapExhausted":null},"stateSyncErrors":[]}
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

assert_contains "$output" 'Token credentials eligible for manual provider-usage refresh:'
assert_contains "$output" '1) claude-primary (anthropic, active) id=anthropic-id updatedAt=2026-03-19T12:00:00Z'
assert_contains "$output" '2) openai-primary (openai, active) id=openai-id updatedAt=2026-03-19T11:00:00Z'
assert_contains "$output" '3) codex-session (codex, active) id=codex-id updatedAt=2026-03-19T10:00:00Z'
assert_not_contains "$output" 'openai-api-key'
assert_contains "$output" 'tokenCredentialId: codex-id'
assert_contains "$output" 'credential: codex-session (codex)'

curl_url="$(cat "${tmp_dir}/curl-url")"
[[ "$curl_url" == 'http://localhost:4010/v1/admin/token-credentials/codex-id/provider-usage-refresh' ]] || \
  fail "unexpected provider-usage refresh URL: $curl_url"

echo 'PASS: innies-token-usage-refresh only lists manual-refresh-eligible credentials'
