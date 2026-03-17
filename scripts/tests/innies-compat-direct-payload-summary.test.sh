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
  "headers_tsv_path=/tmp/direct-headers.tsv" \
  "direct_access_token_source=claude_code_oauth_token" \
  "payload=shape_good status=200 provider_request_id=req_provider_good request_id=req_issue80_payload_matrix_shape_good token_source=claude_code_oauth_token payload_sha256=sha_good payload_bytes=144" \
  "payload=shape_bad status=400 provider_request_id=req_provider_bad request_id=req_issue80_payload_matrix_shape_bad token_source=claude_code_oauth_token payload_sha256=sha_bad payload_bytes=288" \
  "payload_count=2"
write_lines "$payload_specific_dir/payloads/shape_good/meta.txt" \
  "payload=shape_good" \
  "status=200" \
  "outcome=request_succeeded" \
  "provider_request_id=req_provider_good" \
  "request_id=req_issue80_payload_matrix_shape_good" \
  "token_source=claude_code_oauth_token" \
  "payload_sha256=sha_good" \
  "payload_bytes=144"
write_lines "$payload_specific_dir/payloads/shape_bad/meta.txt" \
  "payload=shape_bad" \
  "status=400" \
  "outcome=reproduced_invalid_request_error" \
  "provider_request_id=req_provider_bad" \
  "request_id=req_issue80_payload_matrix_shape_bad" \
  "token_source=claude_code_oauth_token" \
  "payload_sha256=sha_bad" \
  "payload_bytes=288"

uniform_failure_dir="$TMP_DIR/uniform-failure"
write_lines "$uniform_failure_dir/summary.txt" \
  "target_url=https://api.anthropic.com/v1/messages" \
  "payload=preserved_fail status=400 provider_request_id=req_uniform request_id=req_issue80_payload_matrix_preserved_fail token_source=literal payload_sha256=sha_fail_a payload_bytes=398262" \
  "payload=known_good_direct status=400 provider_request_id=req_uniform request_id=req_issue80_payload_matrix_known_good_direct token_source=literal payload_sha256=sha_fail_b payload_bytes=1552" \
  "payload_count=2"
write_lines "$uniform_failure_dir/payloads/preserved_fail/meta.txt" \
  "payload=preserved_fail" \
  "status=400" \
  "outcome=reproduced_invalid_request_error" \
  "provider_request_id=req_uniform" \
  "request_id=req_issue80_payload_matrix_preserved_fail" \
  "token_source=literal" \
  "payload_sha256=sha_fail_a" \
  "payload_bytes=398262"
write_lines "$uniform_failure_dir/payloads/known_good_direct/meta.txt" \
  "payload=known_good_direct" \
  "status=400" \
  "outcome=reproduced_invalid_request_error" \
  "provider_request_id=req_uniform" \
  "request_id=req_issue80_payload_matrix_known_good_direct" \
  "token_source=literal" \
  "payload_sha256=sha_fail_b" \
  "payload_bytes=1552"

single_payload_dir="$TMP_DIR/single-payload"
write_lines "$single_payload_dir/summary.txt" \
  "target_url=https://api.anthropic.com/v1/messages" \
  "payload=only_payload status=400 provider_request_id=req_single request_id=req_issue80_payload_matrix_only_payload token_source=literal payload_sha256=sha_single payload_bytes=512" \
  "payload_count=1"
write_lines "$single_payload_dir/payloads/only_payload/meta.txt" \
  "payload=only_payload" \
  "status=400" \
  "outcome=reproduced_invalid_request_error" \
  "provider_request_id=req_single" \
  "request_id=req_issue80_payload_matrix_only_payload" \
  "token_source=literal" \
  "payload_sha256=sha_single" \
  "payload_bytes=512"

all_success_dir="$TMP_DIR/all-success"
write_lines "$all_success_dir/summary.txt" \
  "target_url=https://api.anthropic.com/v1/messages" \
  "payload=shape_alpha status=200 provider_request_id=req_alpha request_id=req_issue80_payload_matrix_shape_alpha token_source=claude_code_oauth_token payload_sha256=sha_alpha payload_bytes=1024" \
  "payload=shape_beta status=200 provider_request_id=req_beta request_id=req_issue80_payload_matrix_shape_beta token_source=claude_code_oauth_token payload_sha256=sha_beta payload_bytes=2048" \
  "payload_count=2"
write_lines "$all_success_dir/payloads/shape_alpha/meta.txt" \
  "payload=shape_alpha" \
  "status=200" \
  "outcome=request_succeeded" \
  "provider_request_id=req_alpha" \
  "request_id=req_issue80_payload_matrix_shape_alpha" \
  "token_source=claude_code_oauth_token" \
  "payload_sha256=sha_alpha" \
  "payload_bytes=1024"
write_lines "$all_success_dir/payloads/shape_beta/meta.txt" \
  "payload=shape_beta" \
  "status=200" \
  "outcome=request_succeeded" \
  "provider_request_id=req_beta" \
  "request_id=req_issue80_payload_matrix_shape_beta" \
  "token_source=claude_code_oauth_token" \
  "payload_sha256=sha_beta" \
  "payload_bytes=2048"

run_summary() {
  local input_path="$1"
  local output_dir="$2"
  local stdout_path="$3"
  local stderr_path="$4"
  INNIES_DIRECT_PAYLOAD_SUMMARY_OUT_DIR="$output_dir" "$SCRIPT_PATH" "$input_path" >"$stdout_path" 2>"$stderr_path"
}

run_summary "$payload_specific_dir/summary.txt" "$TMP_DIR/payload-specific-summary" "$TMP_DIR/payload-specific.stdout" "$TMP_DIR/payload-specific.stderr"
run_summary "$uniform_failure_dir" "$TMP_DIR/uniform-failure-summary" "$TMP_DIR/uniform-failure.stdout" "$TMP_DIR/uniform-failure.stderr"
run_summary "$single_payload_dir" "$TMP_DIR/single-payload-summary" "$TMP_DIR/single-payload.stdout" "$TMP_DIR/single-payload.stderr"
run_summary "$all_success_dir" "$TMP_DIR/all-success-summary" "$TMP_DIR/all-success.stdout" "$TMP_DIR/all-success.stderr"

[[ -f "$TMP_DIR/payload-specific-summary/summary.txt" ]]
[[ -f "$TMP_DIR/payload-specific-summary/summary.json" ]]
grep -q '^mode=payload_matrix$' "$TMP_DIR/payload-specific-summary/summary.txt"
grep -q '^classification=transcript_shape_specific$' "$TMP_DIR/payload-specific-summary/summary.txt"
grep -q '^payload_sensitive=true$' "$TMP_DIR/payload-specific-summary/summary.txt"
grep -q '^uniform_failure=false$' "$TMP_DIR/payload-specific-summary/summary.txt"
grep -q '^successful_payloads=shape_good$' "$TMP_DIR/payload-specific-summary/summary.txt"
grep -q '^failing_payloads=shape_bad$' "$TMP_DIR/payload-specific-summary/summary.txt"
grep -q '^payload=shape_good status=200 outcome=request_succeeded provider_request_id=req_provider_good payload_bytes=144$' "$TMP_DIR/payload-specific-summary/summary.txt"
grep -q '^payload=shape_bad status=400 outcome=reproduced_invalid_request_error provider_request_id=req_provider_bad payload_bytes=288$' "$TMP_DIR/payload-specific-summary/summary.txt"
grep -q '^summary_file=' "$TMP_DIR/payload-specific.stdout"

[[ -f "$TMP_DIR/uniform-failure-summary/summary.txt" ]]
[[ -f "$TMP_DIR/uniform-failure-summary/summary.json" ]]
grep -q '^classification=uniform_failure_provider_side_candidate$' "$TMP_DIR/uniform-failure-summary/summary.txt"
grep -q '^payload_sensitive=false$' "$TMP_DIR/uniform-failure-summary/summary.txt"
grep -q '^uniform_failure=true$' "$TMP_DIR/uniform-failure-summary/summary.txt"
grep -q '^all_invalid_request=true$' "$TMP_DIR/uniform-failure-summary/summary.txt"

[[ -f "$TMP_DIR/single-payload-summary/summary.txt" ]]
grep -q '^classification=single_payload_only$' "$TMP_DIR/single-payload-summary/summary.txt"
grep -q '^payload_count=1$' "$TMP_DIR/single-payload-summary/summary.txt"

[[ -f "$TMP_DIR/all-success-summary/summary.txt" ]]
grep -q '^classification=all_success$' "$TMP_DIR/all-success-summary/summary.txt"
grep -q '^all_success=true$' "$TMP_DIR/all-success-summary/summary.txt"

node - "$TMP_DIR/payload-specific-summary/summary.json" "$TMP_DIR/uniform-failure-summary/summary.json" "$TMP_DIR/single-payload-summary/summary.json" "$TMP_DIR/all-success-summary/summary.json" <<'NODE'
const fs = require('fs');

const [payloadSpecificPath, uniformFailurePath, singlePayloadPath, allSuccessPath] = process.argv.slice(2);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const payloadSpecific = readJson(payloadSpecificPath);
const uniformFailure = readJson(uniformFailurePath);
const singlePayload = readJson(singlePayloadPath);
const allSuccess = readJson(allSuccessPath);

if (payloadSpecific.classification !== 'transcript_shape_specific') {
  throw new Error('payload-specific classification mismatch');
}
if (payloadSpecific.payloadSummaries.length !== 2) {
  throw new Error('payload-specific summary count mismatch');
}
if (uniformFailure.classification !== 'uniform_failure_provider_side_candidate') {
  throw new Error('uniform failure classification mismatch');
}
if (uniformFailure.uniformFailure !== true) {
  throw new Error('uniform failure flag mismatch');
}
if (singlePayload.classification !== 'single_payload_only') {
  throw new Error('single payload classification mismatch');
}
if (allSuccess.classification !== 'all_success') {
  throw new Error('all success classification mismatch');
}
if (allSuccess.successCount !== 2) {
  throw new Error('all success count mismatch');
}
NODE
