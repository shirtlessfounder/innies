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

run_report() {
  local output_dir="$1"
  local stdout_path="$2"
  local stderr_path="$3"
  shift 3
  INNIES_COMPAT_EVIDENCE_REPORT_OUT_DIR="$output_dir" "$SCRIPT_PATH" "$@" >"$stdout_path" 2>"$stderr_path"
}

provider_side_root="$TMP_DIR/provider-side-root"
write_lines "$provider_side_root/first-pass-bundle-diff/summary.txt" \
  "left_label=issue80-bundle#upstream" \
  "right_label=direct-bundle#upstream" \
  "payload_canonical_equal=true" \
  "header_value_mismatches=anthropic-beta" \
  "header_only_in_right=accept,authorization,content-type,user-agent,x-app,x-request-id" \
  "body_sha256_left=sha-preserved" \
  "body_sha256_right=sha-direct"
write_lines "$provider_side_root/exact-case/summary.txt" \
  "mode=case_lane_matrix" \
  "classification=uniform_failure_provider_side_candidate" \
  "header_sensitive=false" \
  "token_lane_sensitive=false" \
  "uniform_failure=true" \
  "all_invalid_request=true"
write_lines "$provider_side_root/direct-payload/summary.txt" \
  "mode=payload_matrix" \
  "classification=uniform_failure_provider_side_candidate" \
  "payload_sensitive=false" \
  "uniform_failure=true" \
  "all_invalid_request=true"
write_lines "$provider_side_root/direct-token-lane/summary.txt" \
  "mode=direct_token_lane_matrix" \
  "classification=uniform_failure_provider_side_candidate" \
  "token_lane_sensitive=false" \
  "uniform_failure=true" \
  "all_invalid_request=true"

run_report \
  "$TMP_DIR/provider-side-report" \
  "$TMP_DIR/provider-side.stdout" \
  "$TMP_DIR/provider-side.stderr" \
  "$provider_side_root"

[[ -f "$TMP_DIR/provider-side-report/summary.txt" ]]
[[ -f "$TMP_DIR/provider-side-report/summary.json" ]]
grep -q '^overall_classification=uniform_failure_provider_side_candidate$' "$TMP_DIR/provider-side-report/summary.txt"
grep -q '^recommended_next_step=prepare_provider_escalation_bundle$' "$TMP_DIR/provider-side-report/summary.txt"
grep -q '^provider_side_candidate=true$' "$TMP_DIR/provider-side-report/summary.txt"
grep -q '^incomplete_evidence=false$' "$TMP_DIR/provider-side-report/summary.txt"
grep -q '^available_artifact_types=direct_payload_summary,direct_token_lane_summary,exact_case_summary,first_pass_bundle_diff$' "$TMP_DIR/provider-side-report/summary.txt"
grep -q '^missing_artifact_types=-$' "$TMP_DIR/provider-side-report/summary.txt"
grep -q '^bundle_diff_payload_canonical_equal=true$' "$TMP_DIR/provider-side-report/summary.txt"
grep -q '^bundle_diff_header_value_mismatches=anthropic-beta$' "$TMP_DIR/provider-side-report/summary.txt"
grep -q '^summary_file=' "$TMP_DIR/provider-side.stdout"

mixed_root="$TMP_DIR/mixed-root"
write_lines "$mixed_root/diff-summary.txt" \
  "left_label=issue80-bundle#upstream" \
  "right_label=direct-bundle#upstream" \
  "payload_canonical_equal=true" \
  "header_value_mismatches=anthropic-beta,user-agent" \
  "header_only_in_right=accept,authorization,content-type,x-app,x-request-id"
write_lines "$mixed_root/exact-summary.txt" \
  "mode=case_matrix" \
  "classification=header_case_specific" \
  "header_sensitive=true" \
  "token_lane_sensitive=false" \
  "uniform_failure=false"
write_lines "$mixed_root/payload-summary.txt" \
  "mode=payload_matrix" \
  "classification=transcript_shape_specific" \
  "payload_sensitive=true" \
  "uniform_failure=false"
write_lines "$mixed_root/token-summary.txt" \
  "mode=direct_token_lane_matrix" \
  "classification=credential_lane_specific" \
  "token_lane_sensitive=true" \
  "uniform_failure=false"

run_report \
  "$TMP_DIR/mixed-report" \
  "$TMP_DIR/mixed.stdout" \
  "$TMP_DIR/mixed.stderr" \
  "$mixed_root/diff-summary.txt" \
  "$mixed_root/exact-summary.txt" \
  "$mixed_root/payload-summary.txt" \
  "$mixed_root/token-summary.txt"

grep -q '^overall_classification=mixed_axis_specific$' "$TMP_DIR/mixed-report/summary.txt"
grep -q '^recommended_next_step=split_axes_before_runtime_change$' "$TMP_DIR/mixed-report/summary.txt"
grep -q '^header_sensitive=true$' "$TMP_DIR/mixed-report/summary.txt"
grep -q '^payload_sensitive=true$' "$TMP_DIR/mixed-report/summary.txt"
grep -q '^credential_lane_sensitive=true$' "$TMP_DIR/mixed-report/summary.txt"
grep -q '^provider_side_candidate=false$' "$TMP_DIR/mixed-report/summary.txt"
grep -q '^incomplete_evidence=false$' "$TMP_DIR/mixed-report/summary.txt"

partial_root="$TMP_DIR/partial-root"
write_lines "$partial_root/summary.txt" \
  "left_label=issue80-bundle#upstream" \
  "right_label=direct-bundle#upstream" \
  "payload_canonical_equal=true" \
  "header_value_mismatches=anthropic-beta" \
  "header_only_in_right=accept,authorization,content-type,user-agent,x-app,x-request-id"
write_lines "$partial_root/exact-case-summary.txt" \
  "mode=case_matrix" \
  "classification=header_case_specific" \
  "header_sensitive=true" \
  "token_lane_sensitive=false" \
  "uniform_failure=false"

run_report \
  "$TMP_DIR/partial-report" \
  "$TMP_DIR/partial.stdout" \
  "$TMP_DIR/partial.stderr" \
  "$partial_root/summary.txt" \
  "$partial_root/exact-case-summary.txt"

grep -q '^overall_classification=header_case_specific$' "$TMP_DIR/partial-report/summary.txt"
grep -q '^recommended_next_step=focus_on_header_case_delta$' "$TMP_DIR/partial-report/summary.txt"
grep -q '^incomplete_evidence=true$' "$TMP_DIR/partial-report/summary.txt"
grep -q '^missing_artifact_types=direct_payload_summary,direct_token_lane_summary$' "$TMP_DIR/partial-report/summary.txt"

node - "$TMP_DIR/provider-side-report/summary.json" "$TMP_DIR/mixed-report/summary.json" "$TMP_DIR/partial-report/summary.json" <<'NODE'
const fs = require('fs');

const [providerSidePath, mixedPath, partialPath] = process.argv.slice(2);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const providerSide = readJson(providerSidePath);
const mixed = readJson(mixedPath);
const partial = readJson(partialPath);

if (providerSide.overallClassification !== 'uniform_failure_provider_side_candidate') {
  throw new Error('provider-side overall classification mismatch');
}
if (providerSide.providerSideCandidate !== true) {
  throw new Error('provider-side candidate flag mismatch');
}
if (mixed.overallClassification !== 'mixed_axis_specific') {
  throw new Error('mixed overall classification mismatch');
}
if (mixed.flags.headerSensitive !== true || mixed.flags.payloadSensitive !== true || mixed.flags.credentialLaneSensitive !== true) {
  throw new Error('mixed flags mismatch');
}
if (partial.overallClassification !== 'header_case_specific') {
  throw new Error('partial overall classification mismatch');
}
if (partial.incompleteEvidence !== true) {
  throw new Error('partial incomplete evidence flag mismatch');
}
if (!partial.missingArtifactTypes.includes('direct_payload_summary')) {
  throw new Error('missing payload summary artifact not recorded');
}
NODE
