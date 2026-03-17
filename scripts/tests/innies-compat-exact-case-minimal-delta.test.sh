#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-exact-case-minimal-delta.sh"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

write_case() {
  local file_path="$1"
  shift
  printf '%s\n' "$@" >"$file_path"
}

write_kv() {
  local file_path="$1"
  shift
  printf '%s\n' "$@" >"$file_path"
}

run_single_lane_case() {
  local case_root="$TMP_DIR/single-lane"
  local cases_dir="$case_root/cases-input"
  local matrix_dir="$case_root/matrix"
  local out_dir="$case_root/out"
  local stdout_path="$case_root/stdout.txt"
  local stderr_path="$case_root/stderr.txt"

  mkdir -p "$cases_dir" "$matrix_dir/cases/compat-exact" "$matrix_dir/cases/compat-with-direct-beta" "$matrix_dir/cases/compat-with-direct-identity" "$matrix_dir/cases/compat-with-direct-beta-and-identity"

  write_case "$cases_dir/compat-exact.tsv" \
    $'accept\ttext/event-stream' \
    $'anthropic-beta\tfine-grained-tool-streaming-2025-05-14' \
    $'anthropic-version\t2023-06-01' \
    $'x-request-id\treq_compat_exact'

  write_case "$cases_dir/compat-with-direct-beta.tsv" \
    $'accept\ttext/event-stream' \
    $'anthropic-beta\tfine-grained-tool-streaming-2025-05-14,oauth-2025-04-20' \
    $'anthropic-version\t2023-06-01' \
    $'x-request-id\treq_beta_only'

  write_case "$cases_dir/compat-with-direct-identity.tsv" \
    $'accept\ttext/event-stream' \
    $'anthropic-beta\tfine-grained-tool-streaming-2025-05-14' \
    $'anthropic-dangerous-direct-browser-access\ttrue' \
    $'anthropic-version\t2023-06-01' \
    $'user-agent\tOpenClawGateway/1.0' \
    $'x-app\tcli' \
    $'x-request-id\treq_identity_only'

  write_case "$cases_dir/compat-with-direct-beta-and-identity.tsv" \
    $'accept\ttext/event-stream' \
    $'anthropic-beta\tfine-grained-tool-streaming-2025-05-14,oauth-2025-04-20' \
    $'anthropic-dangerous-direct-browser-access\ttrue' \
    $'anthropic-version\t2023-06-01' \
    $'user-agent\tOpenClawGateway/1.0' \
    $'x-app\tcli' \
    $'x-request-id\treq_beta_and_identity'

  write_kv "$matrix_dir/summary.txt" \
    "body_bytes=398262" \
    "body_sha256=1717a039bed013d162eb47daead7f7eea440bccc6fb2719b9233142976e9a093" \
    "cases_dir=$cases_dir"

  write_kv "$matrix_dir/cases/compat-exact/summary.txt" \
    "case=compat-exact" \
    "status=400" \
    "outcome=reproduced_invalid_request_error"

  write_kv "$matrix_dir/cases/compat-with-direct-beta/summary.txt" \
    "case=compat-with-direct-beta" \
    "status=400" \
    "outcome=reproduced_invalid_request_error"

  write_kv "$matrix_dir/cases/compat-with-direct-identity/summary.txt" \
    "case=compat-with-direct-identity" \
    "status=200" \
    "outcome=request_succeeded"

  write_kv "$matrix_dir/cases/compat-with-direct-beta-and-identity/summary.txt" \
    "case=compat-with-direct-beta-and-identity" \
    "status=200" \
    "outcome=request_succeeded"

  set +e
  INNIES_EXACT_CASE_MINIMAL_DELTA_OUT_DIR="$out_dir" \
    "$SCRIPT_PATH" "$matrix_dir" >"$stdout_path" 2>"$stderr_path"
  local status=$?
  set -e

  if [[ "$status" -ne 0 ]]; then
    cat "$stderr_path" >&2
    exit 1
  fi

  [[ -f "$out_dir/summary.txt" ]]
  [[ -f "$out_dir/summary.json" ]]

  grep -q '^mode=case_matrix$' "$out_dir/summary.txt"
  grep -q '^baseline_case=compat-exact$' "$out_dir/summary.txt"
  grep -q '^baseline_outcome=reproduced_invalid_request_error$' "$out_dir/summary.txt"
  grep -q '^minimal_success_delta_header_count=3$' "$out_dir/summary.txt"
  grep -q '^minimal_success_cases=compat-with-direct-identity$' "$out_dir/summary.txt"
  grep -q '^minimal_success_lanes=direct$' "$out_dir/summary.txt"
  grep -q '^minimal_success_delta_headers=anthropic-dangerous-direct-browser-access,user-agent,x-app$' "$out_dir/summary.txt"
  grep -q '^case=compat-with-direct-identity delta_header_count=3 delta_headers=anthropic-dangerous-direct-browser-access,user-agent,x-app successful_lanes=direct failing_lanes=-$' "$out_dir/summary.txt"

  node - "$out_dir/summary.json" <<'NODE'
const fs = require('fs');
const summary = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (summary.minimalSuccess.case !== 'compat-with-direct-identity') {
  throw new Error(`unexpected minimal success case: ${summary.minimalSuccess.case}`);
}
if (summary.minimalSuccess.deltaHeaderCount !== 3) {
  throw new Error(`unexpected minimal success delta count: ${summary.minimalSuccess.deltaHeaderCount}`);
}
if (summary.minimalSuccess.deltaHeaders.join(',') !== 'anthropic-dangerous-direct-browser-access,user-agent,x-app') {
  throw new Error(`unexpected minimal success delta headers: ${summary.minimalSuccess.deltaHeaders.join(',')}`);
}
NODE
}

run_multi_lane_case() {
  local case_root="$TMP_DIR/multi-lane"
  local cases_dir="$case_root/cases-input"
  local matrix_dir="$case_root/matrix"
  local out_dir="$case_root/out"

  mkdir -p \
    "$cases_dir" \
    "$matrix_dir/lanes/claude-oauth/cases/compat-exact" \
    "$matrix_dir/lanes/claude-oauth/cases/compat-with-direct-identity" \
    "$matrix_dir/lanes/claude-oauth/cases/compat-with-direct-beta-and-identity" \
    "$matrix_dir/lanes/openclaw-direct/cases/compat-exact" \
    "$matrix_dir/lanes/openclaw-direct/cases/compat-with-direct-identity" \
    "$matrix_dir/lanes/openclaw-direct/cases/compat-with-direct-beta-and-identity"

  write_case "$cases_dir/compat-exact.tsv" \
    $'accept\ttext/event-stream' \
    $'anthropic-beta\tfine-grained-tool-streaming-2025-05-14' \
    $'anthropic-version\t2023-06-01'

  write_case "$cases_dir/compat-with-direct-identity.tsv" \
    $'accept\ttext/event-stream' \
    $'anthropic-beta\tfine-grained-tool-streaming-2025-05-14' \
    $'anthropic-dangerous-direct-browser-access\ttrue' \
    $'anthropic-version\t2023-06-01' \
    $'user-agent\tOpenClawGateway/1.0' \
    $'x-app\tcli'

  write_case "$cases_dir/compat-with-direct-beta-and-identity.tsv" \
    $'accept\ttext/event-stream' \
    $'anthropic-beta\tfine-grained-tool-streaming-2025-05-14,oauth-2025-04-20' \
    $'anthropic-dangerous-direct-browser-access\ttrue' \
    $'anthropic-version\t2023-06-01' \
    $'user-agent\tOpenClawGateway/1.0' \
    $'x-app\tcli'

  write_kv "$matrix_dir/summary.txt" \
    "body_bytes=398262" \
    "body_sha256=1717a039bed013d162eb47daead7f7eea440bccc6fb2719b9233142976e9a093" \
    "cases_dir=$cases_dir"

  write_kv "$matrix_dir/lanes/claude-oauth/cases/compat-exact/meta.txt" \
    "lane=claude-oauth" \
    "case=compat-exact" \
    "status=400" \
    "outcome=reproduced_invalid_request_error"

  write_kv "$matrix_dir/lanes/claude-oauth/cases/compat-with-direct-identity/meta.txt" \
    "lane=claude-oauth" \
    "case=compat-with-direct-identity" \
    "status=200" \
    "outcome=request_succeeded"

  write_kv "$matrix_dir/lanes/claude-oauth/cases/compat-with-direct-beta-and-identity/meta.txt" \
    "lane=claude-oauth" \
    "case=compat-with-direct-beta-and-identity" \
    "status=200" \
    "outcome=request_succeeded"

  write_kv "$matrix_dir/lanes/openclaw-direct/cases/compat-exact/meta.txt" \
    "lane=openclaw-direct" \
    "case=compat-exact" \
    "status=400" \
    "outcome=reproduced_invalid_request_error"

  write_kv "$matrix_dir/lanes/openclaw-direct/cases/compat-with-direct-identity/meta.txt" \
    "lane=openclaw-direct" \
    "case=compat-with-direct-identity" \
    "status=400" \
    "outcome=reproduced_invalid_request_error"

  write_kv "$matrix_dir/lanes/openclaw-direct/cases/compat-with-direct-beta-and-identity/meta.txt" \
    "lane=openclaw-direct" \
    "case=compat-with-direct-beta-and-identity" \
    "status=200" \
    "outcome=request_succeeded"

  INNIES_EXACT_CASE_MINIMAL_DELTA_OUT_DIR="$out_dir" \
    "$SCRIPT_PATH" "$matrix_dir"

  grep -q '^mode=case_lane_matrix$' "$out_dir/summary.txt"
  grep -q '^minimal_success_cases=compat-with-direct-identity$' "$out_dir/summary.txt"
  grep -q '^lane=claude-oauth minimal_success_case=compat-with-direct-identity minimal_success_delta_header_count=3 minimal_success_delta_headers=anthropic-dangerous-direct-browser-access,user-agent,x-app$' "$out_dir/summary.txt"
  grep -q '^lane=openclaw-direct minimal_success_case=compat-with-direct-beta-and-identity minimal_success_delta_header_count=4 minimal_success_delta_headers=anthropic-beta,anthropic-dangerous-direct-browser-access,user-agent,x-app$' "$out_dir/summary.txt"

  node - "$out_dir/summary.json" <<'NODE'
const fs = require('fs');
const summary = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (summary.mode !== 'case_lane_matrix') {
  throw new Error(`unexpected mode: ${summary.mode}`);
}
if (!summary.perLane?.['claude-oauth']) {
  throw new Error('missing claude-oauth lane details');
}
if (summary.perLane['claude-oauth'].minimalSuccess.case !== 'compat-with-direct-identity') {
  throw new Error(`unexpected claude-oauth minimal success case: ${summary.perLane['claude-oauth'].minimalSuccess.case}`);
}
if (summary.perLane['openclaw-direct'].minimalSuccess.case !== 'compat-with-direct-beta-and-identity') {
  throw new Error(`unexpected openclaw-direct minimal success case: ${summary.perLane['openclaw-direct'].minimalSuccess.case}`);
}
NODE
}

run_single_lane_case
run_multi_lane_case
