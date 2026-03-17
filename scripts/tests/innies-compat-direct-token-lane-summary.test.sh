#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-direct-token-lane-summary.sh"
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

lane_specific_dir="$TMP_DIR/lane-specific"
write_lines "$lane_specific_dir/summary.txt" \
  "target_url=https://api.anthropic.com/v1/messages" \
  "payload_path=/tmp/preserved-fail.json" \
  "headers_tsv_path=/tmp/direct-headers.tsv" \
  "token_matrix_tsv=/tmp/direct-token-matrix.tsv" \
  "lane=lane_alpha status=200 provider_request_id=req_provider_alpha request_id=req_issue80_token_matrix_lane_alpha token_source=env:ANTHROPIC_TOKEN_ALPHA" \
  "lane=lane_beta status=400 provider_request_id=req_provider_beta request_id=req_issue80_token_matrix_lane_beta token_source=literal"
write_lines "$lane_specific_dir/lanes/lane_alpha/meta.txt" \
  "lane=lane_alpha" \
  "status=200" \
  "outcome=request_succeeded" \
  "provider_request_id=req_provider_alpha" \
  "request_id=req_issue80_token_matrix_lane_alpha" \
  "token_source=env:ANTHROPIC_TOKEN_ALPHA" \
  "target_url=https://api.anthropic.com/v1/messages" \
  "payload_path=/tmp/preserved-fail.json" \
  "headers_tsv_path=/tmp/direct-headers.tsv"
write_lines "$lane_specific_dir/lanes/lane_beta/meta.txt" \
  "lane=lane_beta" \
  "status=400" \
  "outcome=reproduced_invalid_request_error" \
  "provider_request_id=req_provider_beta" \
  "request_id=req_issue80_token_matrix_lane_beta" \
  "token_source=literal" \
  "target_url=https://api.anthropic.com/v1/messages" \
  "payload_path=/tmp/preserved-fail.json" \
  "headers_tsv_path=/tmp/direct-headers.tsv"

uniform_failure_dir="$TMP_DIR/uniform-failure"
write_lines "$uniform_failure_dir/summary.txt" \
  "target_url=https://api.anthropic.com/v1/messages" \
  "payload_path=/tmp/preserved-fail.json" \
  "headers_tsv_path=/tmp/direct-headers.tsv" \
  "token_matrix_tsv=/tmp/direct-token-matrix.tsv"
write_lines "$uniform_failure_dir/lanes/lane_alpha/meta.txt" \
  "lane=lane_alpha" \
  "status=400" \
  "outcome=reproduced_invalid_request_error" \
  "provider_request_id=req_provider_alpha" \
  "request_id=req_issue80_token_matrix_lane_alpha" \
  "token_source=env:ANTHROPIC_TOKEN_ALPHA"
write_lines "$uniform_failure_dir/lanes/lane_beta/meta.txt" \
  "lane=lane_beta" \
  "status=400" \
  "outcome=reproduced_invalid_request_error" \
  "provider_request_id=req_provider_beta" \
  "request_id=req_issue80_token_matrix_lane_beta" \
  "token_source=literal"

single_lane_dir="$TMP_DIR/single-lane"
write_lines "$single_lane_dir/summary.txt" \
  "target_url=https://api.anthropic.com/v1/messages"
write_lines "$single_lane_dir/lanes/lane_only/meta.txt" \
  "lane=lane_only" \
  "status=400" \
  "outcome=reproduced_invalid_request_error" \
  "provider_request_id=req_provider_single" \
  "request_id=req_issue80_token_matrix_lane_only" \
  "token_source=literal"

all_success_dir="$TMP_DIR/all-success"
write_lines "$all_success_dir/summary.txt" \
  "target_url=https://api.anthropic.com/v1/messages"
write_lines "$all_success_dir/lanes/lane_alpha/meta.txt" \
  "lane=lane_alpha" \
  "status=200" \
  "outcome=request_succeeded" \
  "provider_request_id=req_provider_alpha" \
  "request_id=req_issue80_token_matrix_lane_alpha" \
  "token_source=env:ANTHROPIC_TOKEN_ALPHA"
write_lines "$all_success_dir/lanes/lane_beta/meta.txt" \
  "lane=lane_beta" \
  "status=200" \
  "outcome=request_succeeded" \
  "provider_request_id=req_provider_beta" \
  "request_id=req_issue80_token_matrix_lane_beta" \
  "token_source=literal"

invalid_dir="$TMP_DIR/invalid"
write_lines "$invalid_dir/summary.txt" \
  "target_url=https://api.anthropic.com/v1/messages"
mkdir -p "$invalid_dir/lanes/lane_missing"

run_summary() {
  local input_path="$1"
  local output_dir="$2"
  local stdout_path="$3"
  local stderr_path="$4"
  INNIES_DIRECT_TOKEN_LANE_SUMMARY_OUT_DIR="$output_dir" "$SCRIPT_PATH" "$input_path" >"$stdout_path" 2>"$stderr_path"
}

run_summary "$lane_specific_dir/summary.txt" "$TMP_DIR/lane-specific-summary" "$TMP_DIR/lane-specific.stdout" "$TMP_DIR/lane-specific.stderr"
run_summary "$uniform_failure_dir" "$TMP_DIR/uniform-failure-summary" "$TMP_DIR/uniform-failure.stdout" "$TMP_DIR/uniform-failure.stderr"
run_summary "$single_lane_dir" "$TMP_DIR/single-lane-summary" "$TMP_DIR/single-lane.stdout" "$TMP_DIR/single-lane.stderr"
run_summary "$all_success_dir" "$TMP_DIR/all-success-summary" "$TMP_DIR/all-success.stdout" "$TMP_DIR/all-success.stderr"

[[ -f "$TMP_DIR/lane-specific-summary/summary.txt" ]]
[[ -f "$TMP_DIR/lane-specific-summary/summary.json" ]]
grep -q '^mode=direct_token_lane_matrix$' "$TMP_DIR/lane-specific-summary/summary.txt"
grep -q '^classification=credential_lane_specific$' "$TMP_DIR/lane-specific-summary/summary.txt"
grep -q '^token_lane_sensitive=true$' "$TMP_DIR/lane-specific-summary/summary.txt"
grep -q '^uniform_failure=false$' "$TMP_DIR/lane-specific-summary/summary.txt"
grep -q '^successful_lanes=lane_alpha$' "$TMP_DIR/lane-specific-summary/summary.txt"
grep -q '^failing_lanes=lane_beta$' "$TMP_DIR/lane-specific-summary/summary.txt"
grep -q '^lane=lane_alpha status=200 outcome=request_succeeded provider_request_id=req_provider_alpha request_id=req_issue80_token_matrix_lane_alpha token_source=env:ANTHROPIC_TOKEN_ALPHA$' "$TMP_DIR/lane-specific-summary/summary.txt"
grep -q '^lane=lane_beta status=400 outcome=reproduced_invalid_request_error provider_request_id=req_provider_beta request_id=req_issue80_token_matrix_lane_beta token_source=literal$' "$TMP_DIR/lane-specific-summary/summary.txt"
grep -q '^summary_file=' "$TMP_DIR/lane-specific.stdout"

[[ -f "$TMP_DIR/uniform-failure-summary/summary.txt" ]]
grep -q '^classification=uniform_failure_provider_side_candidate$' "$TMP_DIR/uniform-failure-summary/summary.txt"
grep -q '^token_lane_sensitive=false$' "$TMP_DIR/uniform-failure-summary/summary.txt"
grep -q '^uniform_failure=true$' "$TMP_DIR/uniform-failure-summary/summary.txt"
grep -q '^all_invalid_request=true$' "$TMP_DIR/uniform-failure-summary/summary.txt"

[[ -f "$TMP_DIR/single-lane-summary/summary.txt" ]]
grep -q '^classification=single_lane_only$' "$TMP_DIR/single-lane-summary/summary.txt"
grep -q '^lane_count=1$' "$TMP_DIR/single-lane-summary/summary.txt"

[[ -f "$TMP_DIR/all-success-summary/summary.txt" ]]
grep -q '^classification=all_success$' "$TMP_DIR/all-success-summary/summary.txt"
grep -q '^all_success=true$' "$TMP_DIR/all-success-summary/summary.txt"

node - "$TMP_DIR/lane-specific-summary/summary.json" "$TMP_DIR/uniform-failure-summary/summary.json" "$TMP_DIR/single-lane-summary/summary.json" "$TMP_DIR/all-success-summary/summary.json" <<'NODE'
const fs = require('fs');

const [laneSpecificPath, uniformFailurePath, singleLanePath, allSuccessPath] = process.argv.slice(2);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const laneSpecific = readJson(laneSpecificPath);
const uniformFailure = readJson(uniformFailurePath);
const singleLane = readJson(singleLanePath);
const allSuccess = readJson(allSuccessPath);

if (laneSpecific.classification !== 'credential_lane_specific') {
  throw new Error('lane-specific classification mismatch');
}
if (laneSpecific.laneSummaries.length !== 2) {
  throw new Error('lane-specific summary count mismatch');
}
if (uniformFailure.classification !== 'uniform_failure_provider_side_candidate') {
  throw new Error('uniform failure classification mismatch');
}
if (uniformFailure.uniformFailure !== true) {
  throw new Error('uniform failure flag mismatch');
}
if (singleLane.classification !== 'single_lane_only') {
  throw new Error('single lane classification mismatch');
}
if (allSuccess.classification !== 'all_success') {
  throw new Error('all success classification mismatch');
}
if (allSuccess.successCount !== 2) {
  throw new Error('all success count mismatch');
}
NODE

set +e
INNIES_DIRECT_TOKEN_LANE_SUMMARY_OUT_DIR="$TMP_DIR/invalid-summary" \
  "$SCRIPT_PATH" "$invalid_dir" >"$TMP_DIR/invalid.stdout" 2>"$TMP_DIR/invalid.stderr"
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  echo 'expected invalid direct token lane summary input to fail' >&2
  exit 1
fi

grep -q 'missing lane meta file' "$TMP_DIR/invalid.stderr"
