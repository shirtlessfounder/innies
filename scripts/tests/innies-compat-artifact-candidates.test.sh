#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${ROOT_DIR}/scripts/innies-compat-artifact-candidates.sh"

assert_contains() {
  local file="$1"
  local needle="$2"
  if ! grep -Fq "$needle" "$file"; then
    echo "expected to find '$needle' in $file" >&2
    exit 1
  fi
}

test_builds_exact_and_shape_candidate_shortlists() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' RETURN

  mkdir -p \
    "$tmpdir/inputs/fail-exact" \
    "$tmpdir/inputs/good-exact" \
    "$tmpdir/inputs/fail-shape" \
    "$tmpdir/inputs/good-shape" \
    "$tmpdir/inputs/noise"

  cat >"$tmpdir/inputs/fail-exact/summary.json" <<'JSON'
{
  "artifact_path": "/artifacts/fail-exact.html",
  "request_id": "req_fail_exact",
  "provider": "anthropic",
  "upstream_status": 400,
  "classification": "invalid_request_candidate",
  "body_sha256": "sha-exact",
  "body_bytes": 393038,
  "model": "claude-opus-4-6",
  "stream": true,
  "message_count": 425,
  "tool_count": 21,
  "tool_result_block_count": 63,
  "thinking_present": true
}
JSON

  cat >"$tmpdir/inputs/good-exact/summary.json" <<'JSON'
{
  "artifact_path": "/artifacts/good-exact.html",
  "request_id": "req_good_exact",
  "provider": "anthropic",
  "upstream_status": 200,
  "classification": "known_good_candidate",
  "body_sha256": "sha-exact",
  "body_bytes": 393038,
  "model": "claude-opus-4-6",
  "stream": true,
  "message_count": 425,
  "tool_count": 21,
  "tool_result_block_count": 63,
  "thinking_present": true
}
JSON

  cat >"$tmpdir/inputs/fail-shape/summary.json" <<'JSON'
{
  "artifact_path": "/artifacts/fail-shape.html",
  "request_id": "req_fail_shape",
  "provider": "anthropic",
  "upstream_status": 400,
  "classification": "invalid_request_candidate",
  "model": "claude-opus-4-6",
  "stream": true,
  "message_count": 425,
  "tool_count": 21,
  "tool_result_block_count": 63,
  "thinking_present": true
}
JSON

  cat >"$tmpdir/inputs/good-shape/summary.json" <<'JSON'
{
  "artifact_path": "/artifacts/good-shape.html",
  "request_id": "req_good_shape",
  "provider": "anthropic",
  "upstream_status": 200,
  "classification": "known_good_candidate",
  "model": "claude-opus-4-6",
  "stream": true,
  "message_count": 425,
  "tool_count": 21,
  "tool_result_block_count": 63,
  "thinking_present": true
}
JSON

  cat >"$tmpdir/inputs/noise/summary.json" <<'JSON'
{
  "artifact_path": "/artifacts/noise.html",
  "request_id": "req_noise",
  "provider": "anthropic",
  "upstream_status": 200,
  "classification": "known_good_candidate",
  "body_sha256": "sha-noise",
  "body_bytes": 120,
  "model": "claude-sonnet-4-5",
  "stream": false,
  "message_count": 2,
  "tool_count": 0,
  "tool_result_block_count": 0,
  "thinking_present": false
}
JSON

  INNIES_COMPAT_ARTIFACT_CANDIDATES_OUT_DIR="$tmpdir/out" \
    "$SCRIPT" "$tmpdir/inputs" >/tmp/innies-compat-artifact-candidates.out

  assert_contains "$tmpdir/out/summary.txt" 'artifact_count=5'
  assert_contains "$tmpdir/out/summary.txt" 'exact_body_match_candidates=1'
  assert_contains "$tmpdir/out/summary.txt" 'shape_match_candidates=1'
  assert_contains "$tmpdir/out/summary.txt" 'recommended_exact_pair=req_fail_exact -> req_good_exact'
  assert_contains "$tmpdir/out/summary.txt" 'recommended_shape_pair=req_fail_shape -> req_good_shape'
  assert_contains "$tmpdir/out/summary.txt" 'recommended_next_action=run exact bundle diff on the recommended exact-body pair first'

  node <<'NODE' "$tmpdir/out/summary.json"
const fs = require('node:fs');
const path = process.argv[1];
const summary = JSON.parse(fs.readFileSync(path, 'utf8'));
if (summary.artifactCount !== 5) throw new Error(`artifactCount=${summary.artifactCount}`);
if (summary.exactBodyCandidates.length !== 1) throw new Error(`exact=${summary.exactBodyCandidates.length}`);
if (summary.shapeCandidates.length !== 1) throw new Error(`shape=${summary.shapeCandidates.length}`);
if (summary.exactBodyCandidates[0].recommendedPair.failure.requestId !== 'req_fail_exact') {
  throw new Error('unexpected exact failure request id');
}
if (summary.exactBodyCandidates[0].recommendedPair.success.requestId !== 'req_good_exact') {
  throw new Error('unexpected exact success request id');
}
if (summary.shapeCandidates[0].recommendedPair.failure.requestId !== 'req_fail_shape') {
  throw new Error('unexpected shape failure request id');
}
if (summary.shapeCandidates[0].recommendedPair.success.requestId !== 'req_good_shape') {
  throw new Error('unexpected shape success request id');
}
NODE
}

test_fails_when_no_summary_json_exists() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' RETURN

  mkdir -p "$tmpdir/empty"

  if INNIES_COMPAT_ARTIFACT_CANDIDATES_OUT_DIR="$tmpdir/out" "$SCRIPT" "$tmpdir/empty" >"$tmpdir/stdout" 2>"$tmpdir/stderr"; then
    echo 'expected helper to fail when no summary.json files are present' >&2
    exit 1
  fi

  assert_contains "$tmpdir/stderr" 'error: no summary.json files found in input paths'
}

test_builds_exact_and_shape_candidate_shortlists
test_fails_when_no_summary_json_exists
