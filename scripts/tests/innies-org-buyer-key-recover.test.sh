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
touch "${tmp_dir}/empty.env"

cat > "${tmp_dir}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

headers_file=""
body_file=""
method="GET"
url=""
auth_header=""

while (($# > 0)); do
  case "$1" in
    -D)
      headers_file="$2"
      shift 2
      ;;
    -o)
      body_file="$2"
      shift 2
      ;;
    -w|-X|-H|--data-binary)
      if [[ "$1" == "-X" ]]; then
        method="$2"
      elif [[ "$1" == "-H" && "$2" == Authorization:* ]]; then
        auth_header="$2"
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

printf '%s %s\n' "$method" "$url" >> "${TEST_TMP_DIR}/requests.log"
printf '%s\n' "$auth_header" >> "${TEST_TMP_DIR}/auth.log"

cat > "$headers_file" <<'HEADERS'
HTTP/1.1 200 OK
Content-Type: application/json

HEADERS

case "$url" in
  http://localhost:4010/v1/admin/orgs/acme/members)
    cat > "$body_file" <<'JSON'
{"members":[{"userId":"user_owner","githubLogin":"owner-login","membershipId":"membership_owner","isOwner":true},{"userId":"user_member","githubLogin":"member-login","membershipId":"membership_member","isOwner":false}]}
JSON
    printf '200'
    ;;
  http://localhost:4010/v1/admin/orgs/acme/members/membership_member/buyer-key/rotate)
    if [[ "${RECOVER_RESPONSE_MODE:-ok}" == 'malformed' ]]; then
      cat > "$body_file" <<'JSON'
{"membershipId":"membership_member","apiKeyId":"api_key_rotated"}
JSON
    else
      cat > "$body_file" <<'JSON'
{"membershipId":"membership_member","apiKeyId":"api_key_rotated","plaintextKey":"in_live_rotated"}
JSON
    fi
    printf '200'
    ;;
  *)
    cat > "$body_file" <<'JSON'
{"code":"not_found","message":"unexpected url"}
JSON
    printf '404'
    ;;
esac
EOF
chmod +x "${tmp_dir}/curl"

if ! output="$(
  PATH="${tmp_dir}:$PATH" \
  TEST_TMP_DIR="${tmp_dir}" \
  INNIES_ENV_FILE="${tmp_dir}/empty.env" \
  INNIES_ADMIN_API_KEY="in_admin_test" \
  bash "${ROOT_DIR}/scripts/innies-org-buyer-key-recover.sh" --org acme --github Member-Login 2>&1
)"; then
  fail "expected recovery script to resolve github login and rotate key, got:\n${output}"
fi

assert_contains "$output" 'orgSlug: acme'
assert_contains "$output" 'membershipId: membership_member'
assert_contains "$output" 'githubLogin: member-login'
assert_contains "$output" 'apiKeyId: api_key_rotated'
assert_contains "$output" 'buyerKey: in_live_rotated'

requests="$(cat "${tmp_dir}/requests.log")"
assert_contains "$requests" 'GET http://localhost:4010/v1/admin/orgs/acme/members'
assert_contains "$requests" 'POST http://localhost:4010/v1/admin/orgs/acme/members/membership_member/buyer-key/rotate'

auth_headers="$(cat "${tmp_dir}/auth.log")"
assert_contains "$auth_headers" 'Authorization: Bearer in_admin_test'

if ! json_output="$(
  PATH="${tmp_dir}:$PATH" \
  TEST_TMP_DIR="${tmp_dir}" \
  INNIES_ENV_FILE="${tmp_dir}/empty.env" \
  INNIES_ADMIN_API_KEY="in_admin_test" \
  bash "${ROOT_DIR}/scripts/innies-org-buyer-key-recover.sh" --org acme --membership membership_member --json 2>&1
)"; then
  fail "expected recovery script to emit json for membership lookup, got:\n${json_output}"
fi

assert_contains "$json_output" '"orgSlug": "acme"'
assert_contains "$json_output" '"membershipId": "membership_member"'
assert_contains "$json_output" '"githubLogin": "member-login"'
assert_contains "$json_output" '"apiKeyId": "api_key_rotated"'
assert_contains "$json_output" '"plaintextBuyerKey": "in_live_rotated"'

if malformed_output="$(
  PATH="${tmp_dir}:$PATH" \
  TEST_TMP_DIR="${tmp_dir}" \
  INNIES_ENV_FILE="${tmp_dir}/empty.env" \
  RECOVER_RESPONSE_MODE="malformed" \
  INNIES_ADMIN_API_KEY="in_admin_test" \
  bash "${ROOT_DIR}/scripts/innies-org-buyer-key-recover.sh" --org acme --membership membership_member 2>&1
)"; then
  fail "expected malformed rotate response to fail, got:\n${malformed_output}"
fi

assert_contains "$malformed_output" 'error: malformed rotate response from admin API'

echo 'PASS: innies-org-buyer-key-recover resolves github login and rotates via admin route'
