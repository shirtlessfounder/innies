#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-exact-case-summary.sh"
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

case_matrix_dir="$TMP_DIR/case-matrix"
write_lines "$case_matrix_dir/summary.txt" \
  "case_count=2" \
  "case=compat-exact status=400 outcome=reproduced_invalid_request_error provider_request_id=req_case_fail anthropic_beta=fine-grained-tool-streaming-2025-05-14 identity_headers=false" \
  "case=compat-with-all-direct-deltas status=200 outcome=request_succeeded provider_request_id=req_case_success anthropic_beta=fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14 identity_headers=true"
write_lines "$case_matrix_dir/cases/compat-exact/summary.txt" \
  "case=compat-exact" \
  "status=400" \
  "outcome=reproduced_invalid_request_error" \
  "provider_request_id=req_case_fail" \
  "anthropic_beta=fine-grained-tool-streaming-2025-05-14" \
  "identity_headers=false"
write_lines "$case_matrix_dir/cases/compat-with-all-direct-deltas/summary.txt" \
  "case=compat-with-all-direct-deltas" \
  "status=200" \
  "outcome=request_succeeded" \
  "provider_request_id=req_case_success" \
  "anthropic_beta=fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14" \
  "identity_headers=true"

case_lane_dir="$TMP_DIR/case-lane-matrix"
write_lines "$case_lane_dir/summary.txt" \
  "case_count=2" \
  "lane_count=2" \
  "lane=lane_alpha case=compat-exact status=400 outcome=reproduced_invalid_request_error provider_request_id=req_alpha_fail request_id=req_alpha_case_fail token_source=env:ANTHROPIC_TOKEN_ALPHA" \
  "lane=lane_alpha case=compat-with-all-direct-deltas status=200 outcome=request_succeeded provider_request_id=req_alpha_success request_id=req_alpha_case_success token_source=env:ANTHROPIC_TOKEN_ALPHA" \
  "lane=lane_beta case=compat-exact status=400 outcome=reproduced_invalid_request_error provider_request_id=req_beta_fail request_id=req_beta_case_fail token_source=literal" \
  "lane=lane_beta case=compat-with-all-direct-deltas status=400 outcome=reproduced_invalid_request_error provider_request_id=req_beta_fail request_id=req_beta_case_fail_2 token_source=literal"
write_lines "$case_lane_dir/lanes/lane_alpha/cases/compat-exact/meta.txt" \
  "lane=lane_alpha" \
  "case=compat-exact" \
  "status=400" \
  "outcome=reproduced_invalid_request_error" \
  "provider_request_id=req_alpha_fail" \
  "token_source=env:ANTHROPIC_TOKEN_ALPHA"
write_lines "$case_lane_dir/lanes/lane_alpha/cases/compat-with-all-direct-deltas/meta.txt" \
  "lane=lane_alpha" \
  "case=compat-with-all-direct-deltas" \
  "status=200" \
  "outcome=request_succeeded" \
  "provider_request_id=req_alpha_success" \
  "token_source=env:ANTHROPIC_TOKEN_ALPHA"
write_lines "$case_lane_dir/lanes/lane_beta/cases/compat-exact/meta.txt" \
  "lane=lane_beta" \
  "case=compat-exact" \
  "status=400" \
  "outcome=reproduced_invalid_request_error" \
  "provider_request_id=req_beta_fail" \
  "token_source=literal"
write_lines "$case_lane_dir/lanes/lane_beta/cases/compat-with-all-direct-deltas/meta.txt" \
  "lane=lane_beta" \
  "case=compat-with-all-direct-deltas" \
  "status=400" \
  "outcome=reproduced_invalid_request_error" \
  "provider_request_id=req_beta_fail" \
  "token_source=literal"

uniform_failure_dir="$TMP_DIR/uniform-failure"
write_lines "$uniform_failure_dir/summary.txt" \
  "case_count=2" \
  "lane_count=2" \
  "lane=lane_alpha case=compat-exact status=400 outcome=reproduced_invalid_request_error provider_request_id=req_uniform_fail request_id=req_uniform_a_case_exact token_source=env:ANTHROPIC_TOKEN_ALPHA" \
  "lane=lane_alpha case=compat-with-direct-identity status=400 outcome=reproduced_invalid_request_error provider_request_id=req_uniform_fail request_id=req_uniform_a_case_identity token_source=env:ANTHROPIC_TOKEN_ALPHA" \
  "lane=lane_beta case=compat-exact status=400 outcome=reproduced_invalid_request_error provider_request_id=req_uniform_fail request_id=req_uniform_b_case_exact token_source=literal" \
  "lane=lane_beta case=compat-with-direct-identity status=400 outcome=reproduced_invalid_request_error provider_request_id=req_uniform_fail request_id=req_uniform_b_case_identity token_source=literal"
write_lines "$uniform_failure_dir/lanes/lane_alpha/cases/compat-exact/meta.txt" \
  "lane=lane_alpha" \
  "case=compat-exact" \
  "status=400" \
  "outcome=reproduced_invalid_request_error" \
  "provider_request_id=req_uniform_fail" \
  "token_source=env:ANTHROPIC_TOKEN_ALPHA"
write_lines "$uniform_failure_dir/lanes/lane_alpha/cases/compat-with-direct-identity/meta.txt" \
  "lane=lane_alpha" \
  "case=compat-with-direct-identity" \
  "status=400" \
  "outcome=reproduced_invalid_request_error" \
  "provider_request_id=req_uniform_fail" \
  "token_source=env:ANTHROPIC_TOKEN_ALPHA"
write_lines "$uniform_failure_dir/lanes/lane_beta/cases/compat-exact/meta.txt" \
  "lane=lane_beta" \
  "case=compat-exact" \
  "status=400" \
  "outcome=reproduced_invalid_request_error" \
  "provider_request_id=req_uniform_fail" \
  "token_source=literal"
write_lines "$uniform_failure_dir/lanes/lane_beta/cases/compat-with-direct-identity/meta.txt" \
  "lane=lane_beta" \
  "case=compat-with-direct-identity" \
  "status=400" \
  "outcome=reproduced_invalid_request_error" \
  "provider_request_id=req_uniform_fail" \
  "token_source=literal"

run_summary() {
  local input_dir="$1"
  local output_dir="$2"
  local stdout_path="$3"
  local stderr_path="$4"
  INNIES_EXACT_CASE_SUMMARY_OUT_DIR="$output_dir" "$SCRIPT_PATH" "$input_dir" >"$stdout_path" 2>"$stderr_path"
}

run_summary "$case_matrix_dir" "$TMP_DIR/case-matrix-summary" "$TMP_DIR/case-matrix.stdout" "$TMP_DIR/case-matrix.stderr"
run_summary "$case_lane_dir" "$TMP_DIR/case-lane-summary" "$TMP_DIR/case-lane.stdout" "$TMP_DIR/case-lane.stderr"
run_summary "$uniform_failure_dir" "$TMP_DIR/uniform-failure-summary" "$TMP_DIR/uniform-failure.stdout" "$TMP_DIR/uniform-failure.stderr"

[[ -f "$TMP_DIR/case-matrix-summary/summary.txt" ]]
[[ -f "$TMP_DIR/case-matrix-summary/summary.json" ]]
grep -q '^mode=case_matrix$' "$TMP_DIR/case-matrix-summary/summary.txt"
grep -q '^classification=header_case_specific$' "$TMP_DIR/case-matrix-summary/summary.txt"
grep -q '^header_sensitive=true$' "$TMP_DIR/case-matrix-summary/summary.txt"
grep -q '^token_lane_sensitive=false$' "$TMP_DIR/case-matrix-summary/summary.txt"
grep -q '^successful_cases=compat-with-all-direct-deltas$' "$TMP_DIR/case-matrix-summary/summary.txt"
grep -q '^failing_cases=compat-exact$' "$TMP_DIR/case-matrix-summary/summary.txt"
grep -q '^summary_file=' "$TMP_DIR/case-matrix.stdout"

[[ -f "$TMP_DIR/case-lane-summary/summary.txt" ]]
[[ -f "$TMP_DIR/case-lane-summary/summary.json" ]]
grep -q '^mode=case_lane_matrix$' "$TMP_DIR/case-lane-summary/summary.txt"
grep -q '^classification=mixed_case_and_lane_specific$' "$TMP_DIR/case-lane-summary/summary.txt"
grep -q '^header_sensitive=true$' "$TMP_DIR/case-lane-summary/summary.txt"
grep -q '^token_lane_sensitive=true$' "$TMP_DIR/case-lane-summary/summary.txt"
grep -q '^successful_lanes=lane_alpha$' "$TMP_DIR/case-lane-summary/summary.txt"
grep -q '^failing_lanes=lane_beta$' "$TMP_DIR/case-lane-summary/summary.txt"
grep -q '^lane=lane_alpha success_count=1 invalid_request_count=1 successful_cases=compat-with-all-direct-deltas failing_cases=compat-exact$' "$TMP_DIR/case-lane-summary/summary.txt"
grep -q '^case=compat-with-all-direct-deltas success_count=1 invalid_request_count=1 successful_lanes=lane_alpha failing_lanes=lane_beta$' "$TMP_DIR/case-lane-summary/summary.txt"

[[ -f "$TMP_DIR/uniform-failure-summary/summary.txt" ]]
[[ -f "$TMP_DIR/uniform-failure-summary/summary.json" ]]
grep -q '^classification=uniform_failure_provider_side_candidate$' "$TMP_DIR/uniform-failure-summary/summary.txt"
grep -q '^uniform_failure=true$' "$TMP_DIR/uniform-failure-summary/summary.txt"
grep -q '^all_invalid_request=true$' "$TMP_DIR/uniform-failure-summary/summary.txt"

node - "$TMP_DIR/case-matrix-summary/summary.json" "$TMP_DIR/case-lane-summary/summary.json" "$TMP_DIR/uniform-failure-summary/summary.json" <<'NODE'
const fs = require('fs');

const [caseMatrixPath, caseLanePath, uniformFailurePath] = process.argv.slice(2);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const caseMatrix = readJson(caseMatrixPath);
const caseLane = readJson(caseLanePath);
const uniformFailure = readJson(uniformFailurePath);

if (caseMatrix.classification !== 'header_case_specific') {
  throw new Error('case matrix classification mismatch');
}
if (caseMatrix.mode !== 'case_matrix') {
  throw new Error('case matrix mode mismatch');
}
if (caseMatrix.caseSummaries.length !== 2) {
  throw new Error('case matrix summary count mismatch');
}
if (caseLane.classification !== 'mixed_case_and_lane_specific') {
  throw new Error('case lane classification mismatch');
}
if (caseLane.laneSummaries.length !== 2) {
  throw new Error('case lane summary count mismatch');
}
if (caseLane.caseSummaries.length !== 2) {
  throw new Error('case lane case summary count mismatch');
}
if (uniformFailure.classification !== 'uniform_failure_provider_side_candidate') {
  throw new Error('uniform failure classification mismatch');
}
if (uniformFailure.uniformFailure !== true) {
  throw new Error('uniform failure flag mismatch');
}
NODE
