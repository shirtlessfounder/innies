#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-evidence-report.sh"
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

header_case_dir="$TMP_DIR/header-case"
write_lines "$header_case_dir/summary.txt" \
  "mode=case_matrix" \
  "classification=header_case_specific" \
  "header_sensitive=true" \
  "token_lane_sensitive=false" \
  "uniform_failure=false" \
  "body_sha256=1717a039bed013d162eb47daead7f7eea440bccc6fb2719b9233142976e9a093" \
  "successful_cases=compat-with-direct-beta-and-identity" \
  "failing_cases=compat-exact,compat-with-direct-beta,compat-with-direct-identity"

minimal_delta_dir="$TMP_DIR/minimal-delta"
write_lines "$minimal_delta_dir/summary.txt" \
  "mode=case_matrix" \
  "conclusion=beta_and_identity_candidate" \
  "baseline_case=compat-exact" \
  "baseline_reproduced=true" \
  "minimal_success_case=compat-with-direct-beta-and-identity" \
  "minimal_success_delta=beta_and_identity" \
  "successful_lanes=direct" \
  "blocked_lanes=-"

payload_uniform_dir="$TMP_DIR/payload-uniform"
write_lines "$payload_uniform_dir/summary.txt" \
  "mode=payload_matrix" \
  "classification=uniform_failure_provider_side_candidate" \
  "payload_sensitive=false" \
  "uniform_failure=true" \
  "all_invalid_request=true"

token_uniform_dir="$TMP_DIR/token-uniform"
write_lines "$token_uniform_dir/summary.txt" \
  "mode=direct_token_lane_matrix" \
  "classification=uniform_failure_provider_side_candidate" \
  "token_lane_sensitive=false" \
  "uniform_failure=true" \
  "all_invalid_request=true"

provider_exact_dir="$TMP_DIR/provider-exact"
write_lines "$provider_exact_dir/summary.txt" \
  "mode=case_matrix" \
  "classification=uniform_failure_provider_side_candidate" \
  "header_sensitive=false" \
  "token_lane_sensitive=false" \
  "uniform_failure=true" \
  "body_sha256=1717a039bed013d162eb47daead7f7eea440bccc6fb2719b9233142976e9a093"

provider_payload_dir="$TMP_DIR/provider-payload"
write_lines "$provider_payload_dir/summary.txt" \
  "mode=payload_matrix" \
  "classification=uniform_failure_provider_side_candidate" \
  "payload_sensitive=false" \
  "uniform_failure=true" \
  "all_invalid_request=true"

provider_token_dir="$TMP_DIR/provider-token"
write_lines "$provider_token_dir/summary.txt" \
  "mode=direct_token_lane_matrix" \
  "classification=uniform_failure_provider_side_candidate" \
  "token_lane_sensitive=false" \
  "uniform_failure=true" \
  "all_invalid_request=true"

run_report() {
  local output_dir="$1"
  shift
  local stdout_path="$1"
  shift
  local stderr_path="$1"
  shift
  INNIES_COMPAT_EVIDENCE_REPORT_OUT_DIR="$output_dir" \
    "$SCRIPT_PATH" "$@" >"$stdout_path" 2>"$stderr_path"
}

run_report "$TMP_DIR/header-report" "$TMP_DIR/header.stdout" "$TMP_DIR/header.stderr" \
  --exact-case-summary "$header_case_dir/summary.txt" \
  --exact-case-minimal-delta "$minimal_delta_dir/summary.txt" \
  --payload-summary "$payload_uniform_dir/summary.txt" \
  --token-lane-summary "$token_uniform_dir/summary.txt"

[[ -f "$TMP_DIR/header-report/summary.txt" ]]
[[ -f "$TMP_DIR/header-report/summary.json" ]]
[[ -f "$TMP_DIR/header-report/issue-comment.md" ]]
grep -q '^mode=issue80_evidence_report$' "$TMP_DIR/header-report/summary.txt"
grep -q '^evidence_axes=exact_case,minimal_delta,payload,token_lane$' "$TMP_DIR/header-report/summary.txt"
grep -q '^overall_classification=header_delta_specific$' "$TMP_DIR/header-report/summary.txt"
grep -q '^next_hypothesis=beta_and_identity_candidate$' "$TMP_DIR/header-report/summary.txt"
grep -q '^exact_case_classification=header_case_specific$' "$TMP_DIR/header-report/summary.txt"
grep -q '^minimal_delta_conclusion=beta_and_identity_candidate$' "$TMP_DIR/header-report/summary.txt"
grep -q '^minimal_success_case=compat-with-direct-beta-and-identity$' "$TMP_DIR/header-report/summary.txt"
grep -q '^summary_file=' "$TMP_DIR/header.stdout"
grep -q '^issue_comment_file=' "$TMP_DIR/header.stdout"
grep -q 'Recommended next hypothesis: `beta_and_identity_candidate`' "$TMP_DIR/header-report/issue-comment.md"
grep -q 'Exact-case evidence points at a remaining header delta' "$TMP_DIR/header-report/issue-comment.md"

run_report "$TMP_DIR/provider-report" "$TMP_DIR/provider.stdout" "$TMP_DIR/provider.stderr" \
  --exact-case-summary "$provider_exact_dir/summary.txt" \
  --payload-summary "$provider_payload_dir/summary.txt" \
  --token-lane-summary "$provider_token_dir/summary.txt"

[[ -f "$TMP_DIR/provider-report/summary.txt" ]]
[[ -f "$TMP_DIR/provider-report/issue-comment.md" ]]
grep -q '^overall_classification=provider_side_candidate$' "$TMP_DIR/provider-report/summary.txt"
grep -q '^next_hypothesis=provider_side_candidate$' "$TMP_DIR/provider-report/summary.txt"
grep -q '^provider_side_candidate=true$' "$TMP_DIR/provider-report/summary.txt"
grep -q 'All available controlled axes stayed uniform' "$TMP_DIR/provider-report/issue-comment.md"

set +e
INNIES_COMPAT_EVIDENCE_REPORT_OUT_DIR="$TMP_DIR/invalid-report" \
  "$SCRIPT_PATH" >"$TMP_DIR/invalid.stdout" 2>"$TMP_DIR/invalid.stderr"
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  echo 'expected evidence report helper without inputs to fail' >&2
  exit 1
fi

grep -q 'at least one evidence input path is required' "$TMP_DIR/invalid.stderr"
