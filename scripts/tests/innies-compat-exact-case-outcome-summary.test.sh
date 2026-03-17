#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-exact-case-outcome-summary.sh"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

write_multi_axis_fixture() {
  local dir="$1"
  mkdir -p "$dir"
  cat >"$dir/summary.txt" <<'EOF'
target_url=https://api.anthropic.com/v1/messages
body_bytes=393038
body_sha256=abc123
case_count=3
lane_count=2
cases_dir=/tmp/cases
token_matrix_tsv=/tmp/token-matrix.tsv
lane=lane_alpha case=compat-exact status=400 outcome=reproduced_invalid_request_error provider_request_id=req_provider_fail_1 request_id=req_issue80_case_1 token_source=env:ANTHROPIC_TOKEN_ALPHA
lane=lane_alpha case=compat-with-direct-beta status=400 outcome=reproduced_invalid_request_error provider_request_id=req_provider_fail_2 request_id=req_issue80_case_2 token_source=env:ANTHROPIC_TOKEN_ALPHA
lane=lane_alpha case=compat-with-all-direct-deltas status=200 outcome=request_succeeded provider_request_id=req_provider_ok request_id=req_issue80_case_3 token_source=env:ANTHROPIC_TOKEN_ALPHA
lane=lane_beta case=compat-exact status=400 outcome=reproduced_invalid_request_error provider_request_id=req_provider_fail_3 request_id=req_issue80_case_4 token_source=env:ANTHROPIC_TOKEN_BETA
lane=lane_beta case=compat-with-direct-beta status=400 outcome=reproduced_invalid_request_error provider_request_id=req_provider_fail_4 request_id=req_issue80_case_5 token_source=env:ANTHROPIC_TOKEN_BETA
lane=lane_beta case=compat-with-all-direct-deltas status=400 outcome=reproduced_invalid_request_error provider_request_id=req_provider_fail_5 request_id=req_issue80_case_6 token_source=env:ANTHROPIC_TOKEN_BETA
EOF
}

write_case_only_fixture() {
  local dir="$1"
  mkdir -p "$dir"
  cat >"$dir/summary.txt" <<'EOF'
target_url=https://api.anthropic.com/v1/messages
body_bytes=393038
body_sha256=def456
case_count=2
cases_dir=/tmp/cases
direct_access_token_source=claude_code_oauth_token
case=compat-exact status=400 outcome=reproduced_invalid_request_error provider_request_id=req_provider_fail request_id=req_issue80_case_only_1
case=compat-with-direct-identity status=200 outcome=request_succeeded provider_request_id=req_provider_ok request_id=req_issue80_case_only_2
EOF
}

write_lane_only_fixture() {
  local dir="$1"
  mkdir -p "$dir"
  cat >"$dir/summary.txt" <<'EOF'
target_url=https://api.anthropic.com/v1/messages
body_bytes=393038
body_sha256=ghi789
case_count=2
lane_count=2
cases_dir=/tmp/cases
token_matrix_tsv=/tmp/token-matrix.tsv
lane=lane_alpha case=compat-exact status=200 outcome=request_succeeded provider_request_id=req_provider_ok_1 request_id=req_issue80_lane_only_1 token_source=env:ANTHROPIC_TOKEN_ALPHA
lane=lane_alpha case=compat-with-direct-beta status=200 outcome=request_succeeded provider_request_id=req_provider_ok_2 request_id=req_issue80_lane_only_2 token_source=env:ANTHROPIC_TOKEN_ALPHA
lane=lane_beta case=compat-exact status=400 outcome=reproduced_invalid_request_error provider_request_id=req_provider_fail_1 request_id=req_issue80_lane_only_3 token_source=env:ANTHROPIC_TOKEN_BETA
lane=lane_beta case=compat-with-direct-beta status=400 outcome=reproduced_invalid_request_error provider_request_id=req_provider_fail_2 request_id=req_issue80_lane_only_4 token_source=env:ANTHROPIC_TOKEN_BETA
EOF
}

write_no_flip_fixture() {
  local dir="$1"
  mkdir -p "$dir"
  cat >"$dir/summary.txt" <<'EOF'
target_url=https://api.anthropic.com/v1/messages
body_bytes=393038
body_sha256=jkl012
case_count=2
lane_count=2
cases_dir=/tmp/cases
token_matrix_tsv=/tmp/token-matrix.tsv
lane=lane_alpha case=compat-exact status=400 outcome=reproduced_invalid_request_error provider_request_id=req_provider_fail_1 request_id=req_issue80_no_flip_1 token_source=env:ANTHROPIC_TOKEN_ALPHA
lane=lane_alpha case=compat-with-direct-beta status=400 outcome=reproduced_invalid_request_error provider_request_id=req_provider_fail_2 request_id=req_issue80_no_flip_2 token_source=env:ANTHROPIC_TOKEN_ALPHA
lane=lane_beta case=compat-exact status=400 outcome=reproduced_invalid_request_error provider_request_id=req_provider_fail_3 request_id=req_issue80_no_flip_3 token_source=env:ANTHROPIC_TOKEN_BETA
lane=lane_beta case=compat-with-direct-beta status=400 outcome=reproduced_invalid_request_error provider_request_id=req_provider_fail_4 request_id=req_issue80_no_flip_4 token_source=env:ANTHROPIC_TOKEN_BETA
EOF
}

MULTI_DIR="$TMP_DIR/multi-axis"
write_multi_axis_fixture "$MULTI_DIR"
"$SCRIPT_PATH" "$MULTI_DIR/summary.txt" >"$MULTI_DIR/stdout.txt"

[[ -f "$MULTI_DIR/outcome-summary.txt" ]]
[[ -f "$MULTI_DIR/case-summary.tsv" ]]
[[ -f "$MULTI_DIR/lane-summary.tsv" ]]
grep -q '^matrix_type=exact_case_token_lane$' "$MULTI_DIR/outcome-summary.txt"
grep -q '^run_count=6$' "$MULTI_DIR/outcome-summary.txt"
grep -q '^case_count=3$' "$MULTI_DIR/outcome-summary.txt"
grep -q '^lane_count=2$' "$MULTI_DIR/outcome-summary.txt"
grep -q '^case_axis_flips=true$' "$MULTI_DIR/outcome-summary.txt"
grep -q '^lane_axis_flips=true$' "$MULTI_DIR/outcome-summary.txt"
grep -q '^axis_classification=case_and_lane$' "$MULTI_DIR/outcome-summary.txt"
grep -q '^inference=controlled_case_and_token_lane_changes_flip_outcome$' "$MULTI_DIR/outcome-summary.txt"
grep -q '^successful_cases=compat-with-all-direct-deltas$' "$MULTI_DIR/outcome-summary.txt"
grep -q '^successful_lanes=lane_alpha$' "$MULTI_DIR/outcome-summary.txt"
grep -q $'^compat-with-all-direct-deltas\t2\t2\t200,400\trequest_succeeded,reproduced_invalid_request_error\tlane_alpha\tlane_beta$' "$MULTI_DIR/case-summary.tsv"
grep -q $'^lane_alpha\t3\t3\t200,400\trequest_succeeded,reproduced_invalid_request_error\tcompat-with-all-direct-deltas\tcompat-exact,compat-with-direct-beta$' "$MULTI_DIR/lane-summary.tsv"
grep -q '^summary_file=' "$MULTI_DIR/stdout.txt"
grep -q '^case_summary_file=' "$MULTI_DIR/stdout.txt"
grep -q '^lane_summary_file=' "$MULTI_DIR/stdout.txt"

CASE_ONLY_DIR="$TMP_DIR/case-only"
write_case_only_fixture "$CASE_ONLY_DIR"
"$SCRIPT_PATH" "$CASE_ONLY_DIR" >"$CASE_ONLY_DIR/stdout.txt"

[[ -f "$CASE_ONLY_DIR/outcome-summary.txt" ]]
grep -q '^matrix_type=exact_case$' "$CASE_ONLY_DIR/outcome-summary.txt"
grep -q '^lane_count=1$' "$CASE_ONLY_DIR/outcome-summary.txt"
grep -q '^case_axis_flips=true$' "$CASE_ONLY_DIR/outcome-summary.txt"
grep -q '^lane_axis_flips=false$' "$CASE_ONLY_DIR/outcome-summary.txt"
grep -q '^axis_classification=case_only$' "$CASE_ONLY_DIR/outcome-summary.txt"
grep -q '^inference=controlled_case_changes_flip_outcome$' "$CASE_ONLY_DIR/outcome-summary.txt"
grep -q '^successful_lanes=single_lane$' "$CASE_ONLY_DIR/outcome-summary.txt"
grep -q $'^single_lane\t2\t2\t200,400\trequest_succeeded,reproduced_invalid_request_error\tcompat-with-direct-identity\tcompat-exact$' "$CASE_ONLY_DIR/lane-summary.tsv"

LANE_ONLY_DIR="$TMP_DIR/lane-only"
write_lane_only_fixture "$LANE_ONLY_DIR"
"$SCRIPT_PATH" "$LANE_ONLY_DIR/summary.txt" >"$LANE_ONLY_DIR/stdout.txt"

grep -q '^axis_classification=lane_only$' "$LANE_ONLY_DIR/outcome-summary.txt"
grep -q '^inference=controlled_token_lane_changes_flip_outcome$' "$LANE_ONLY_DIR/outcome-summary.txt"
grep -q '^case_axis_flips=false$' "$LANE_ONLY_DIR/outcome-summary.txt"
grep -q '^lane_axis_flips=true$' "$LANE_ONLY_DIR/outcome-summary.txt"
grep -q '^successful_cases=compat-exact,compat-with-direct-beta$' "$LANE_ONLY_DIR/outcome-summary.txt"
grep -q '^successful_lanes=lane_alpha$' "$LANE_ONLY_DIR/outcome-summary.txt"

NO_FLIP_DIR="$TMP_DIR/no-flip"
write_no_flip_fixture "$NO_FLIP_DIR"
"$SCRIPT_PATH" "$NO_FLIP_DIR/summary.txt" >"$NO_FLIP_DIR/stdout.txt"

grep -q '^axis_classification=no_controlled_axis_flip$' "$NO_FLIP_DIR/outcome-summary.txt"
grep -q '^inference=remaining_delta_outside_controlled_case_or_lane_matrix$' "$NO_FLIP_DIR/outcome-summary.txt"
grep -q '^all_runs_same_outcome=true$' "$NO_FLIP_DIR/outcome-summary.txt"
grep -q '^successful_cases=none$' "$NO_FLIP_DIR/outcome-summary.txt"
grep -q '^successful_lanes=none$' "$NO_FLIP_DIR/outcome-summary.txt"

EMPTY_DIR="$TMP_DIR/empty"
mkdir -p "$EMPTY_DIR"
cat >"$EMPTY_DIR/summary.txt" <<'EOF'
target_url=https://api.anthropic.com/v1/messages
body_bytes=393038
body_sha256=mno345
case_count=0
lane_count=0
EOF

set +e
"$SCRIPT_PATH" "$EMPTY_DIR/summary.txt" >"$EMPTY_DIR/stdout.txt" 2>"$EMPTY_DIR/stderr.txt"
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  echo 'expected empty summary invocation to fail' >&2
  exit 1
fi

grep -q 'no case outcome rows found' "$EMPTY_DIR/stderr.txt"
