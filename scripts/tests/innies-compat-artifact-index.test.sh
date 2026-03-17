#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-artifact-index.sh"
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

artifact_path="$TMP_DIR/response_issue80_sample.html"
write_lines "$artifact_path" \
  "Mar 17 12:00:00 host bash[1]: [compat-upstream-request-json-chunk] {" \
  "Mar 17 12:00:00 host bash[1]:   chunk_index: 0," \
  "Mar 17 12:00:00 host bash[1]:   chunk_count: 1," \
  "Mar 17 12:00:00 host bash[1]:   json: '{\"request_id\":\"req_success\",\"attempt_no\":1,\"provider\":\"anthropic\",\"proxied_path\":\"/v1/messages\",\"target_url\":\"https://api.anthropic.com/v1/messages\",\"model\":\"claude-opus-4-6\",\"body_bytes\":111,\"body_sha256\":\"sha_success\",\"headers\":{\"anthropic-beta\":\"beta_success\",\"user-agent\":\"OpenClawGateway/1.0\",\"x-app\":\"cli\",\"x-request-id\":\"req_success\"}}'" \
  "Mar 17 12:00:00 host bash[1]: }" \
  "Mar 17 12:00:00 host bash[1]: [compat-upstream-response-json-chunk] {" \
  "Mar 17 12:00:00 host bash[1]:   chunk_index: 0," \
  "Mar 17 12:00:00 host bash[1]:   chunk_count: 1," \
  "Mar 17 12:00:00 host bash[1]:   json: '{\"request_id\":\"req_success\",\"provider\":\"anthropic\",\"upstream_status\":200,\"parsed_body\":{\"request_id\":\"req_provider_success\"},\"response_headers\":{\"request-id\":\"req_provider_success\"}}'" \
  "Mar 17 12:00:00 host bash[1]: }" \
  "Mar 17 12:00:00 host bash[1]: [compat-upstream-request-json-chunk] {" \
  "Mar 17 12:00:00 host bash[1]:   chunk_index: 0," \
  "Mar 17 12:00:00 host bash[1]:   chunk_count: 1," \
  "Mar 17 12:00:00 host bash[1]:   json: '{\"request_id\":\"req_fail\",\"attempt_no\":1,\"provider\":\"anthropic\",\"proxied_path\":\"/v1/messages\",\"target_url\":\"https://api.anthropic.com/v1/messages\",\"model\":\"claude-opus-4-6\",\"body_bytes\":222,\"body_sha256\":\"sha_fail\",\"headers\":{\"anthropic-beta\":\"beta_fail\",\"user-agent\":\"OpenClawGateway/1.0\",\"x-app\":\"cli\",\"x-request-id\":\"req_fail\"}}'" \
  "Mar 17 12:00:00 host bash[1]: }" \
  "Mar 17 12:00:00 host bash[1]: [compat-upstream-response-json-chunk] {" \
  "Mar 17 12:00:00 host bash[1]:   chunk_index: 0," \
  "Mar 17 12:00:00 host bash[1]:   chunk_count: 1," \
  "Mar 17 12:00:00 host bash[1]:   json: '{\"request_id\":\"req_fail\",\"provider\":\"anthropic\",\"upstream_status\":400,\"parsed_body\":{\"request_id\":\"req_provider_fail\"},\"response_headers\":{\"request-id\":\"req_provider_fail\"}}'" \
  "Mar 17 12:00:00 host bash[1]: }" \
  "Mar 17 12:00:00 host bash[1]: [compat-invalid-request-debug-json-chunk] {" \
  "Mar 17 12:00:00 host bash[1]:   chunk_index: 0," \
  "Mar 17 12:00:00 host bash[1]:   chunk_count: 1," \
  "Mar 17 12:00:00 host bash[1]:   json: '{\"request_id\":\"req_fail\",\"provider\":\"anthropic\"}'" \
  "Mar 17 12:00:00 host bash[1]: }" \
  "Mar 17 12:00:00 host bash[1]: [compat-invalid-request-payload-json-chunk] {" \
  "Mar 17 12:00:00 host bash[1]:   chunk_index: 0," \
  "Mar 17 12:00:00 host bash[1]:   chunk_count: 1," \
  "Mar 17 12:00:00 host bash[1]:   json: '{\"request_id\":\"req_fail\",\"payload\":{\"model\":\"claude-opus-4-6\"}}'" \
  "Mar 17 12:00:00 host bash[1]: }" \
  "Mar 17 12:00:00 host bash[1]: [compat-upstream-request-json-chunk] {" \
  "Mar 17 12:00:00 host bash[1]:   chunk_index: 0," \
  "Mar 17 12:00:00 host bash[1]:   chunk_count: 1," \
  "Mar 17 12:00:00 host bash[1]:   json: '{\"request_id\":\"req_openai\",\"attempt_no\":1,\"provider\":\"openai\",\"proxied_path\":\"/v1/messages\",\"target_url\":\"https://api.openai.com/v1/responses\",\"model\":\"gpt-5.4\",\"body_bytes\":333,\"body_sha256\":\"sha_openai\",\"headers\":{\"x-request-id\":\"req_openai\"}}'" \
  "Mar 17 12:00:00 host bash[1]: }" \
  "Mar 17 12:00:00 host bash[1]: [compat-upstream-response-json-chunk] {" \
  "Mar 17 12:00:00 host bash[1]:   chunk_index: 0," \
  "Mar 17 12:00:00 host bash[1]:   chunk_count: 1," \
  "Mar 17 12:00:00 host bash[1]:   json: '{\"request_id\":\"req_openai\",\"provider\":\"openai\",\"upstream_status\":200,\"parsed_body\":{\"request_id\":\"req_provider_openai\"},\"response_headers\":{\"request-id\":\"req_provider_openai\"}}'" \
  "Mar 17 12:00:00 host bash[1]: }"

run_index() {
  local output_dir="$1"
  local stdout_path="$2"
  local stderr_path="$3"
  shift 3
  INNIES_COMPAT_ARTIFACT_INDEX_OUT_DIR="$output_dir" "$SCRIPT_PATH" "$artifact_path" "$@" >"$stdout_path" 2>"$stderr_path"
}

run_index "$TMP_DIR/all" "$TMP_DIR/all.stdout" "$TMP_DIR/all.stderr"
run_index "$TMP_DIR/anthropic-200" "$TMP_DIR/anthropic-200.stdout" "$TMP_DIR/anthropic-200.stderr" anthropic 200

[[ -f "$TMP_DIR/all/summary.txt" ]]
[[ -f "$TMP_DIR/all/summary.json" ]]
grep -q '^mode=compat_artifact_index$' "$TMP_DIR/all/summary.txt"
grep -q '^entry_count=3$' "$TMP_DIR/all/summary.txt"
grep -q '^matching_entry_count=3$' "$TMP_DIR/all/summary.txt"
grep -q '^known_good_candidate_count=1$' "$TMP_DIR/all/summary.txt"
grep -q '^invalid_request_candidate_count=1$' "$TMP_DIR/all/summary.txt"
grep -q '^request_id=req_success provider=anthropic upstream_status=200 candidate_type=known_good_candidate provider_request_id=req_provider_success body_sha256=sha_success has_upstream_request=true has_upstream_response=true has_invalid_debug=false has_invalid_payload=false$' "$TMP_DIR/all/summary.txt"
grep -q '^request_id=req_fail provider=anthropic upstream_status=400 candidate_type=invalid_request_candidate provider_request_id=req_provider_fail body_sha256=sha_fail has_upstream_request=true has_upstream_response=true has_invalid_debug=true has_invalid_payload=true$' "$TMP_DIR/all/summary.txt"
grep -q '^request_id=req_openai provider=openai upstream_status=200 candidate_type=other provider_request_id=req_provider_openai body_sha256=sha_openai has_upstream_request=true has_upstream_response=true has_invalid_debug=false has_invalid_payload=false$' "$TMP_DIR/all/summary.txt"
grep -q '^summary_file=' "$TMP_DIR/all.stdout"

[[ -f "$TMP_DIR/anthropic-200/summary.txt" ]]
[[ -f "$TMP_DIR/anthropic-200/summary.json" ]]
grep -q '^provider_filter=anthropic$' "$TMP_DIR/anthropic-200/summary.txt"
grep -q '^status_filter=200$' "$TMP_DIR/anthropic-200/summary.txt"
grep -q '^entry_count=3$' "$TMP_DIR/anthropic-200/summary.txt"
grep -q '^matching_entry_count=1$' "$TMP_DIR/anthropic-200/summary.txt"
grep -q '^request_id=req_success provider=anthropic upstream_status=200 candidate_type=known_good_candidate provider_request_id=req_provider_success body_sha256=sha_success has_upstream_request=true has_upstream_response=true has_invalid_debug=false has_invalid_payload=false$' "$TMP_DIR/anthropic-200/summary.txt"
if grep -q '^request_id=req_fail ' "$TMP_DIR/anthropic-200/summary.txt"; then
  echo 'expected anthropic 200 filter to exclude req_fail' >&2
  exit 1
fi

node - "$TMP_DIR/all/summary.json" "$TMP_DIR/anthropic-200/summary.json" <<'NODE'
const fs = require('fs');

const [allPath, filteredPath] = process.argv.slice(2);
const allSummary = JSON.parse(fs.readFileSync(allPath, 'utf8'));
const filteredSummary = JSON.parse(fs.readFileSync(filteredPath, 'utf8'));

if (allSummary.entries.length !== 3) {
  throw new Error('expected three indexed entries');
}

const successEntry = allSummary.entries.find((entry) => entry.requestId === 'req_success');
if (!successEntry || successEntry.candidateType !== 'known_good_candidate') {
  throw new Error('missing success candidate');
}

const failureEntry = allSummary.entries.find((entry) => entry.requestId === 'req_fail');
if (!failureEntry || failureEntry.candidateType !== 'invalid_request_candidate') {
  throw new Error('missing failure candidate');
}

if (filteredSummary.entries.length !== 1 || filteredSummary.entries[0].requestId !== 'req_success') {
  throw new Error('expected one filtered anthropic 200 entry');
}
NODE

set +e
run_index "$TMP_DIR/no-match" "$TMP_DIR/no-match.stdout" "$TMP_DIR/no-match.stderr" anthropic 204
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo 'expected no-match filter to fail' >&2
  exit 1
fi

grep -q 'no matching compat artifact entries found' "$TMP_DIR/no-match.stderr"

interleaved_artifact_path="$TMP_DIR/response_issue80_interleaved.html"
write_lines "$interleaved_artifact_path" \
  "Mar 17 12:10:00 host bash[1]: [compat-upstream-request-json-chunk] {" \
  "Mar 17 12:10:00 host bash[1]:   chunk_index: 0," \
  "Mar 17 12:10:00 host bash[1]:   chunk_count: 2," \
  "Mar 17 12:10:00 host bash[1]:   json: '{\"request_id\":\"req_interleave_a\",\"attempt_no\":1,\"provider\":\"anthropic\",\"body_sha256\":\"'" \
  "Mar 17 12:10:00 host bash[1]: }" \
  "Mar 17 12:10:00 host bash[1]: [compat-upstream-request-json-chunk] {" \
  "Mar 17 12:10:00 host bash[1]:   chunk_index: 0," \
  "Mar 17 12:10:00 host bash[1]:   chunk_count: 2," \
  "Mar 17 12:10:00 host bash[1]:   json: '{\"request_id\":\"req_interleave_b\",\"attempt_no\":1,\"provider\":\"anthropic\",\"body_sha256\":\"'" \
  "Mar 17 12:10:00 host bash[1]: }" \
  "Mar 17 12:10:00 host bash[1]: [compat-upstream-request-json-chunk] {" \
  "Mar 17 12:10:00 host bash[1]:   chunk_index: 1," \
  "Mar 17 12:10:00 host bash[1]:   chunk_count: 2," \
  "Mar 17 12:10:00 host bash[1]:   json: 'sha_a\",\"headers\":{\"x-request-id\":\"req_interleave_a\"}}'" \
  "Mar 17 12:10:00 host bash[1]: }" \
  "Mar 17 12:10:00 host bash[1]: [compat-upstream-request-json-chunk] {" \
  "Mar 17 12:10:00 host bash[1]:   chunk_index: 1," \
  "Mar 17 12:10:00 host bash[1]:   chunk_count: 2," \
  "Mar 17 12:10:00 host bash[1]:   json: 'sha_b\",\"headers\":{\"x-request-id\":\"req_interleave_b\"}}'" \
  "Mar 17 12:10:00 host bash[1]: }" \
  "Mar 17 12:10:00 host bash[1]: [compat-upstream-response-json-chunk] {" \
  "Mar 17 12:10:00 host bash[1]:   chunk_index: 0," \
  "Mar 17 12:10:00 host bash[1]:   chunk_count: 2," \
  "Mar 17 12:10:00 host bash[1]:   json: '{\"request_id\":\"req_interleave_a\",\"provider\":\"anthropic\",\"upstream_status\":'" \
  "Mar 17 12:10:00 host bash[1]: }" \
  "Mar 17 12:10:00 host bash[1]: [compat-upstream-response-json-chunk] {" \
  "Mar 17 12:10:00 host bash[1]:   chunk_index: 0," \
  "Mar 17 12:10:00 host bash[1]:   chunk_count: 2," \
  "Mar 17 12:10:00 host bash[1]:   json: '{\"request_id\":\"req_interleave_b\",\"provider\":\"anthropic\",\"upstream_status\":'" \
  "Mar 17 12:10:00 host bash[1]: }" \
  "Mar 17 12:10:00 host bash[1]: [compat-upstream-response-json-chunk] {" \
  "Mar 17 12:10:00 host bash[1]:   chunk_index: 1," \
  "Mar 17 12:10:00 host bash[1]:   chunk_count: 2," \
  "Mar 17 12:10:00 host bash[1]:   json: '400,\"parsed_body\":{\"request_id\":\"provider_a\"}}'" \
  "Mar 17 12:10:00 host bash[1]: }" \
  "Mar 17 12:10:00 host bash[1]: [compat-upstream-response-json-chunk] {" \
  "Mar 17 12:10:00 host bash[1]:   chunk_index: 1," \
  "Mar 17 12:10:00 host bash[1]:   chunk_count: 2," \
  "Mar 17 12:10:00 host bash[1]:   json: '200,\"parsed_body\":{\"request_id\":\"provider_b\"}}'" \
  "Mar 17 12:10:00 host bash[1]: }"

INNIES_COMPAT_ARTIFACT_INDEX_OUT_DIR="$TMP_DIR/interleaved" \
  "$SCRIPT_PATH" "$interleaved_artifact_path" >"$TMP_DIR/interleaved.stdout" 2>"$TMP_DIR/interleaved.stderr"

node - "$TMP_DIR/interleaved/summary.json" <<'NODE'
const fs = require('fs');

const summary = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (summary.entries.length !== 2) {
  throw new Error(`expected two interleaved entries, got ${summary.entries.length}`);
}

const first = summary.entries.find((entry) => entry.requestId === 'req_interleave_a');
if (!first || first.bodySha256 !== 'sha_a' || first.providerRequestId !== 'provider_a') {
  throw new Error('missing req_interleave_a with its own reconstructed body/response');
}

const second = summary.entries.find((entry) => entry.requestId === 'req_interleave_b');
if (!second || second.bodySha256 !== 'sha_b' || second.providerRequestId !== 'provider_b') {
  throw new Error('missing req_interleave_b with its own reconstructed body/response');
}
NODE

echo "PASS: innies-compat-artifact-index indexes saved compat artifacts"
