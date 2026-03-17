#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-exact-case-minimal-delta.sh"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

write_summary() {
  local target_dir="$1"
  local case_name="$2"
  local status="$3"
  local outcome="$4"
  local lane_name="${5:-}"

  mkdir -p "$target_dir"
  {
    printf 'case=%s\n' "$case_name"
    if [[ -n "$lane_name" ]]; then
      printf 'lane=%s\n' "$lane_name"
    fi
    printf 'status=%s\n' "$status"
    printf 'outcome=%s\n' "$outcome"
  } >"$target_dir/summary.txt"
}

IDENTITY_MATRIX_DIR="$TMP_DIR/identity-matrix"
IDENTITY_OUT_DIR="$TMP_DIR/identity-out"
mkdir -p "$IDENTITY_MATRIX_DIR/cases"
cat >"$IDENTITY_MATRIX_DIR/summary.txt" <<'EOF'
body_bytes=393038
body_sha256=1717a039bed013d162eb47daead7f7eea440bccc6fb2719b9233142976e9a093
EOF
write_summary "$IDENTITY_MATRIX_DIR/cases/compat-exact" "compat-exact" "400" "reproduced_invalid_request_error"
write_summary "$IDENTITY_MATRIX_DIR/cases/compat-with-direct-beta" "compat-with-direct-beta" "400" "reproduced_invalid_request_error"
write_summary "$IDENTITY_MATRIX_DIR/cases/compat-with-direct-identity" "compat-with-direct-identity" "200" "request_succeeded"
write_summary "$IDENTITY_MATRIX_DIR/cases/compat-with-direct-beta-and-identity" "compat-with-direct-beta-and-identity" "200" "request_succeeded"
write_summary "$IDENTITY_MATRIX_DIR/cases/compat-with-all-direct-deltas" "compat-with-all-direct-deltas" "200" "request_succeeded"
write_summary "$IDENTITY_MATRIX_DIR/cases/direct-exact" "direct-exact" "200" "request_succeeded"

"$SCRIPT_PATH" "$IDENTITY_MATRIX_DIR" "$IDENTITY_OUT_DIR" >"$TMP_DIR/identity-stdout.txt"

[[ -f "$IDENTITY_OUT_DIR/minimal-delta.txt" ]]
[[ -f "$IDENTITY_OUT_DIR/minimal-delta.json" ]]
grep -q '^conclusion=identity_headers_only_candidate$' "$IDENTITY_OUT_DIR/minimal-delta.txt"
grep -q '^minimal_success_case=compat-with-direct-identity$' "$IDENTITY_OUT_DIR/minimal-delta.txt"
grep -q '^minimal_success_delta=identity_only$' "$IDENTITY_OUT_DIR/minimal-delta.txt"
grep -q '^summary_file=' "$TMP_DIR/identity-stdout.txt"

node - "$IDENTITY_OUT_DIR/minimal-delta.json" <<'NODE'
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (data.conclusion !== 'identity_headers_only_candidate') {
  throw new Error(`unexpected conclusion: ${data.conclusion}`);
}
if (data.minimalSuccessCase !== 'compat-with-direct-identity') {
  throw new Error(`unexpected minimal success case: ${data.minimalSuccessCase}`);
}
if (data.baselineReproduced !== true) {
  throw new Error(`expected baseline reproduction to be true, got ${data.baselineReproduced}`);
}
NODE

LANE_MATRIX_DIR="$TMP_DIR/lane-matrix"
LANE_OUT_DIR="$TMP_DIR/lane-out"
mkdir -p "$LANE_MATRIX_DIR/lanes/lane_alpha/cases" "$LANE_MATRIX_DIR/lanes/lane_beta/cases"
cat >"$LANE_MATRIX_DIR/summary.txt" <<'EOF'
body_bytes=393038
body_sha256=1717a039bed013d162eb47daead7f7eea440bccc6fb2719b9233142976e9a093
EOF
write_summary "$LANE_MATRIX_DIR/lanes/lane_alpha/cases/compat-exact" "compat-exact" "400" "reproduced_invalid_request_error" "lane_alpha"
write_summary "$LANE_MATRIX_DIR/lanes/lane_alpha/cases/compat-with-direct-identity" "compat-with-direct-identity" "200" "request_succeeded" "lane_alpha"
write_summary "$LANE_MATRIX_DIR/lanes/lane_alpha/cases/compat-with-all-direct-deltas" "compat-with-all-direct-deltas" "200" "request_succeeded" "lane_alpha"
write_summary "$LANE_MATRIX_DIR/lanes/lane_beta/cases/compat-exact" "compat-exact" "400" "reproduced_invalid_request_error" "lane_beta"
write_summary "$LANE_MATRIX_DIR/lanes/lane_beta/cases/compat-with-direct-identity" "compat-with-direct-identity" "400" "reproduced_invalid_request_error" "lane_beta"
write_summary "$LANE_MATRIX_DIR/lanes/lane_beta/cases/compat-with-all-direct-deltas" "compat-with-all-direct-deltas" "200" "request_succeeded" "lane_beta"

"$SCRIPT_PATH" "$LANE_MATRIX_DIR" "$LANE_OUT_DIR" >"$TMP_DIR/lane-stdout.txt"

grep -q '^conclusion=lane_specific_followup_required$' "$LANE_OUT_DIR/minimal-delta.txt"
grep -q '^shared_minimal_success_case=-$' "$LANE_OUT_DIR/minimal-delta.txt"
grep -q '^successful_lanes=lane_alpha,lane_beta$' "$LANE_OUT_DIR/minimal-delta.txt"
grep -q '^lane=lane_alpha baseline_outcome=reproduced_invalid_request_error minimal_success_case=compat-with-direct-identity minimal_success_delta=identity_only successful_cases=compat-with-direct-identity,compat-with-all-direct-deltas$' "$LANE_OUT_DIR/minimal-delta.txt"
grep -q '^lane=lane_beta baseline_outcome=reproduced_invalid_request_error minimal_success_case=compat-with-all-direct-deltas minimal_success_delta=additional_direct_delta successful_cases=compat-with-all-direct-deltas$' "$LANE_OUT_DIR/minimal-delta.txt"

node - "$LANE_OUT_DIR/minimal-delta.json" <<'NODE'
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (data.conclusion !== 'lane_specific_followup_required') {
  throw new Error(`unexpected lane conclusion: ${data.conclusion}`);
}
if (data.sharedMinimalSuccessCase !== null) {
  throw new Error(`expected no shared minimal success case, got ${data.sharedMinimalSuccessCase}`);
}
const perLane = Object.fromEntries(data.laneAnalyses.map((entry) => [entry.lane, entry]));
if (perLane.lane_alpha.minimalSuccessCase !== 'compat-with-direct-identity') {
  throw new Error('lane_alpha minimal success case mismatch');
}
if (perLane.lane_beta.minimalSuccessCase !== 'compat-with-all-direct-deltas') {
  throw new Error('lane_beta minimal success case mismatch');
}
NODE

UNIFORM_MATRIX_DIR="$TMP_DIR/uniform-matrix"
UNIFORM_OUT_DIR="$TMP_DIR/uniform-out"
mkdir -p "$UNIFORM_MATRIX_DIR/cases"
write_summary "$UNIFORM_MATRIX_DIR/cases/compat-exact" "compat-exact" "400" "reproduced_invalid_request_error"
write_summary "$UNIFORM_MATRIX_DIR/cases/compat-with-direct-beta" "compat-with-direct-beta" "400" "reproduced_invalid_request_error"
write_summary "$UNIFORM_MATRIX_DIR/cases/compat-with-direct-identity" "compat-with-direct-identity" "400" "reproduced_invalid_request_error"

"$SCRIPT_PATH" "$UNIFORM_MATRIX_DIR" "$UNIFORM_OUT_DIR" >"$TMP_DIR/uniform-stdout.txt"

grep -q '^conclusion=no_controlled_case_success$' "$UNIFORM_OUT_DIR/minimal-delta.txt"
grep -q '^minimal_success_case=-$' "$UNIFORM_OUT_DIR/minimal-delta.txt"

node - "$UNIFORM_OUT_DIR/minimal-delta.json" <<'NODE'
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (data.conclusion !== 'no_controlled_case_success') {
  throw new Error(`unexpected uniform conclusion: ${data.conclusion}`);
}
if (data.minimalSuccessCase !== null) {
  throw new Error(`expected no minimal success case, got ${data.minimalSuccessCase}`);
}
NODE
