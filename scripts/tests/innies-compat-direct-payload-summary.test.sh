#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-direct-payload-summary.sh"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

write_lines() {
  local file="$1"
  shift
  mkdir -p "$(dirname "$file")"
  printf '%s\n' "$@" >"$file"
}

payload_specific_dir="$TMP_DIR/payload-specific"
write_lines "$payload_specific_dir/summary.txt" \
  "target_url=https://api.anthropic.com/v1/messages" \
  "payload_matrix_tsv=/tmp/payloads.tsv" \
  "headers_tsv_path=/tmp/direct-headers.tsv" \
  "direct_access_token_source=claude_code_oauth_token" \
  "payload=known_good_direct status=200 provider_request_id=req_provider_good request_id=req_issue80_payload_known_good token_source=claude_code_oauth_token payload_sha256=sha_good payload_bytes=111" \
  "payload=preserved_fail status=400 provider_request_id=req_provider_bad request_id=req_issue80_payload_preserved token_source=claude_code_oauth_token payload_sha256=sha_bad payload_bytes=222" \
  "payload_count=2"
write_lines "$payload_specific_dir/payloads/known_good_direct/meta.txt" \
  "payload=known_good_direct" \
  "status=200" \
  "outcome=request_succeeded" \
  "request_id=req_issue80_payload_known_good" \
  "provider_request_id=req_provider_good" \
  "token_source=claude_code_oauth_token" \
  "payload_sha256=sha_good" \
  "payload_bytes=111"
write_lines "$payload_specific_dir/payloads/preserved_fail/meta.txt" \
  "payload=preserved_fail" \
  "status=400" \
  "outcome=reproduced_invalid_request_error" \
  "request_id=req_issue80_payload_preserved" \
  "provider_request_id=req_provider_bad" \
  "token_source=claude_code_oauth_token" \
  "payload_sha256=sha_bad" \
  "payload_bytes=222"

uniform_failure_dir="$TMP_DIR/uniform-failure"
write_lines "$uniform_failure_dir/summary.txt" \
  "target_url=https://api.anthropic.com/v1/messages" \
  "payload_matrix_tsv=/tmp/payloads.tsv" \
  "headers_tsv_path=/tmp/direct-headers.tsv" \
  "direct_access_token_source=anthropic_oauth_access_token" \
  "payload=preserved_fail status=400 provider_request_id=req_provider_bad_a request_id=req_issue80_payload_fail_a token_source=anthropic_oauth_access_token payload_sha256=sha_fail_a payload_bytes=333" \
  "payload=second_fail status=400 provider_request_id=req_provider_bad_b request_id=req_issue80_payload_fail_b token_source=anthropic_oauth_access_token payload_sha256=sha_fail_b payload_bytes=444" \
  "payload_count=2"
write_lines "$uniform_failure_dir/payloads/preserved_fail/meta.txt" \
  "payload=preserved_fail" \
  "status=400" \
  "outcome=reproduced_invalid_request_error" \
  "request_id=req_issue80_payload_fail_a" \
  "provider_request_id=req_provider_bad_a" \
  "token_source=anthropic_oauth_access_token" \
  "payload_sha256=sha_fail_a" \
  "payload_bytes=333"
write_lines "$uniform_failure_dir/payloads/second_fail/meta.txt" \
  "payload=second_fail" \
  "status=400" \
  "outcome=reproduced_invalid_request_error" \
  "request_id=req_issue80_payload_fail_b" \
  "provider_request_id=req_provider_bad_b" \
  "token_source=anthropic_oauth_access_token" \
  "payload_sha256=sha_fail_b" \
  "payload_bytes=444"

all_success_dir="$TMP_DIR/all-success"
write_lines "$all_success_dir/summary.txt" \
  "target_url=https://api.anthropic.com/v1/messages" \
  "payload_matrix_tsv=/tmp/payloads.tsv" \
  "headers_tsv_path=/tmp/direct-headers.tsv" \
  "direct_access_token_source=claude_code_oauth_token" \
  "payload=known_good_a status=200 provider_request_id=req_provider_success_a request_id=req_issue80_payload_success_a token_source=claude_code_oauth_token payload_sha256=sha_success_a payload_bytes=555" \
  "payload=known_good_b status=200 provider_request_id=req_provider_success_b request_id=req_issue80_payload_success_b token_source=claude_code_oauth_token payload_sha256=sha_success_b payload_bytes=666" \
  "payload_count=2"
write_lines "$all_success_dir/payloads/known_good_a/meta.txt" \
  "payload=known_good_a" \
  "status=200" \
  "outcome=request_succeeded" \
  "request_id=req_issue80_payload_success_a" \
  "provider_request_id=req_provider_success_a" \
  "token_source=claude_code_oauth_token" \
  "payload_sha256=sha_success_a" \
  "payload_bytes=555"
write_lines "$all_success_dir/payloads/known_good_b/meta.txt" \
  "payload=known_good_b" \
  "status=200" \
  "outcome=request_succeeded" \
  "request_id=req_issue80_payload_success_b" \
  "provider_request_id=req_provider_success_b" \
  "token_source=claude_code_oauth_token" \
  "payload_sha256=sha_success_b" \
  "payload_bytes=666"

run_summary() {
  local input_path="$1"
  local output_dir="$2"
  local stdout_path="$3"
  local stderr_path="$4"
  INNIES_DIRECT_PAYLOAD_SUMMARY_OUT_DIR="$output_dir" "$SCRIPT_PATH" "$input_path" >"$stdout_path" 2>"$stderr_path"
}

run_summary "$payload_specific_dir" "$TMP_DIR/payload-specific-summary" "$TMP_DIR/payload-specific.stdout" "$TMP_DIR/payload-specific.stderr"
run_summary "$uniform_failure_dir/summary.txt" "$TMP_DIR/uniform-failure-summary" "$TMP_DIR/uniform-failure.stdout" "$TMP_DIR/uniform-failure.stderr"
run_summary "$all_success_dir" "$TMP_DIR/all-success-summary" "$TMP_DIR/all-success.stdout" "$TMP_DIR/all-success.stderr"

[[ -f "$TMP_DIR/payload-specific-summary/summary.txt" ]]
[[ -f "$TMP_DIR/payload-specific-summary/summary.json" ]]
grep -q '^mode=direct_payload_matrix$' "$TMP_DIR/payload-specific-summary/summary.txt"
grep -q '^classification=payload_shape_specific$' "$TMP_DIR/payload-specific-summary/summary.txt"
grep -q '^payload_sensitive=true$' "$TMP_DIR/payload-specific-summary/summary.txt"
grep -q '^uniform_failure=false$' "$TMP_DIR/payload-specific-summary/summary.txt"
grep -q '^successful_payloads=known_good_direct$' "$TMP_DIR/payload-specific-summary/summary.txt"
grep -q '^failing_payloads=preserved_fail$' "$TMP_DIR/payload-specific-summary/summary.txt"
grep -q '^payload=known_good_direct status=200 outcome=request_succeeded provider_request_id=req_provider_good request_id=req_issue80_payload_known_good$' "$TMP_DIR/payload-specific-summary/summary.txt"
grep -q '^summary_file=' "$TMP_DIR/payload-specific.stdout"

[[ -f "$TMP_DIR/uniform-failure-summary/summary.txt" ]]
[[ -f "$TMP_DIR/uniform-failure-summary/summary.json" ]]
grep -q '^classification=uniform_failure_provider_side_candidate$' "$TMP_DIR/uniform-failure-summary/summary.txt"
grep -q '^payload_sensitive=false$' "$TMP_DIR/uniform-failure-summary/summary.txt"
grep -q '^uniform_failure=true$' "$TMP_DIR/uniform-failure-summary/summary.txt"
grep -q '^all_invalid_request=true$' "$TMP_DIR/uniform-failure-summary/summary.txt"
grep -q '^successful_payloads=-$' "$TMP_DIR/uniform-failure-summary/summary.txt"

[[ -f "$TMP_DIR/all-success-summary/summary.txt" ]]
[[ -f "$TMP_DIR/all-success-summary/summary.json" ]]
grep -q '^classification=all_success$' "$TMP_DIR/all-success-summary/summary.txt"
grep -q '^all_success=true$' "$TMP_DIR/all-success-summary/summary.txt"
grep -q '^payload_sensitive=false$' "$TMP_DIR/all-success-summary/summary.txt"
grep -q '^successful_payloads=known_good_a,known_good_b$' "$TMP_DIR/all-success-summary/summary.txt"

node - "$TMP_DIR/payload-specific-summary/summary.json" "$TMP_DIR/uniform-failure-summary/summary.json" "$TMP_DIR/all-success-summary/summary.json" <<'NODE'
const fs = require('fs');

const [payloadSpecificPath, uniformFailurePath, allSuccessPath] = process.argv.slice(2);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const payloadSpecific = readJson(payloadSpecificPath);
const uniformFailure = readJson(uniformFailurePath);
const allSuccess = readJson(allSuccessPath);

if (payloadSpecific.classification !== 'payload_shape_specific') {
  throw new Error('payload-specific classification mismatch');
}
if (payloadSpecific.payloadSummaries.length !== 2) {
  throw new Error('payload-specific summary count mismatch');
}
if (uniformFailure.classification !== 'uniform_failure_provider_side_candidate') {
  throw new Error('uniform-failure classification mismatch');
}
if (uniformFailure.uniformFailure !== true) {
  throw new Error('uniform-failure flag mismatch');
}
if (allSuccess.classification !== 'all_success') {
  throw new Error('all-success classification mismatch');
}
if (allSuccess.allSuccess !== true) {
  throw new Error('all-success flag mismatch');
}
NODE

empty_dir="$TMP_DIR/empty"
mkdir -p "$empty_dir"
write_lines "$empty_dir/summary.txt" \
  "target_url=https://api.anthropic.com/v1/messages" \
  "payload_count=0"

set +e
"$SCRIPT_PATH" "$empty_dir" >"$TMP_DIR/empty.stdout" 2>"$TMP_DIR/empty.stderr"
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo 'expected missing payload artifacts to fail' >&2
  exit 1
fi

grep -q 'no payload matrix artifacts found' "$TMP_DIR/empty.stderr"

echo "PASS: innies-compat-direct-payload-summary classifies payload-axis results"
