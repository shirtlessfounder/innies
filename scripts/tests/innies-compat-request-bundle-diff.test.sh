#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-request-bundle-diff.sh"
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

write_json() {
  local file="$1"
  local content="$2"
  mkdir -p "$(dirname "$file")"
  printf '%s\n' "$content" >"$file"
}

run_diff() {
  local failing_path="$1"
  local known_good_path="$2"
  local out_dir="$3"
  local stdout_path="$4"
  local stderr_path="$5"
  INNIES_COMPAT_REQUEST_BUNDLE_DIFF_OUT_DIR="$out_dir" \
    "$SCRIPT_PATH" "$failing_path" "$known_good_path" >"$stdout_path" 2>"$stderr_path"
}

header_diff_fail_dir="$TMP_DIR/header-diff-failing"
header_diff_known_dir="$TMP_DIR/header-diff-known-good"

write_json "$header_diff_fail_dir/payload.json" '{"messages":[{"role":"user","content":[{"type":"text","text":"hello from issue 80"}]}],"stream":true,"model":"claude-opus-4-6","max_tokens":4096}'
write_json "$header_diff_known_dir/payload.json" '{"max_tokens":4096,"model":"claude-opus-4-6","stream":true,"messages":[{"content":[{"text":"hello from issue 80","type":"text"}],"role":"user"}]}'

write_json "$header_diff_fail_dir/upstream-request.json" '{
  "method": "POST",
  "target_url": "https://api.anthropic.com/v1/messages",
  "headers": {
    "accept": "text/event-stream",
    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
    "authorization": "Bearer <redacted>",
    "user-agent": "Innies/1.0",
    "x-request-id": "req_fail_header"
  }
}'
write_json "$header_diff_known_dir/direct-request.json" '{
  "method": "POST",
  "target_url": "https://api.anthropic.com/v1/messages",
  "headers": {
    "accept": "text/event-stream",
    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
    "authorization": "Bearer <redacted>",
    "user-agent": "OpenClawGateway/1.0",
    "x-app": "cli",
    "x-request-id": "req_known_header"
  }
}'

write_json "$header_diff_fail_dir/upstream-response.json" '{
  "status": 400,
  "provider_request_id": "req_provider_header_fail",
  "body": {
    "type": "error",
    "error": {
      "type": "invalid_request_error",
      "message": "Error"
    }
  }
}'
write_json "$header_diff_known_dir/direct-response.json" '{
  "status": 200,
  "provider_request_id": "req_provider_header_good",
  "body": {
    "id": "msg_123"
  }
}'

provider_side_fail_dir="$TMP_DIR/provider-side-failing"
provider_side_known_dir="$TMP_DIR/provider-side-known-good"

write_json "$provider_side_fail_dir/payload.json" '{"messages":[{"role":"user","content":[{"type":"text","text":"same payload"}]}],"stream":true}'
mkdir -p "$provider_side_known_dir"
cp "$provider_side_fail_dir/payload.json" "$provider_side_known_dir/payload.json"

write_json "$provider_side_fail_dir/upstream-request.json" '{
  "method": "POST",
  "target_url": "https://api.anthropic.com/v1/messages",
  "headers": {
    "accept": "text/event-stream",
    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
    "authorization": "Bearer <redacted>",
    "x-request-id": "req_provider_fail"
  }
}'
write_json "$provider_side_known_dir/direct-request.json" '{
  "method": "POST",
  "target_url": "https://api.anthropic.com/v1/messages",
  "headers": {
    "accept": "text/event-stream",
    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
    "authorization": "Bearer <redacted>",
    "x-request-id": "req_provider_good"
  }
}'

write_json "$provider_side_fail_dir/upstream-response.json" '{
  "status": 400,
  "provider_request_id": "req_provider_side_fail",
  "body": {
    "type": "error",
    "error": {
      "type": "invalid_request_error",
      "message": "Error"
    }
  }
}'
write_json "$provider_side_known_dir/direct-response.json" '{
  "status": 200,
  "provider_request_id": "req_provider_side_good",
  "body": {
    "id": "msg_456"
  }
}'

body_delta_fail_dir="$TMP_DIR/body-delta-failing"
body_delta_known_dir="$TMP_DIR/body-delta-known-good"

write_json "$body_delta_fail_dir/payload.json" '{"messages":[{"role":"user","content":[{"type":"text","text":"failing text"}]}],"stream":true}'
write_json "$body_delta_known_dir/payload.json" '{"messages":[{"role":"user","content":[{"type":"text","text":"known good text"}]}],"stream":true}'

write_json "$body_delta_fail_dir/upstream-request.json" '{
  "method": "POST",
  "target_url": "https://api.anthropic.com/v1/messages",
  "headers": {
    "accept": "text/event-stream",
    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
    "authorization": "Bearer <redacted>",
    "x-request-id": "req_body_fail"
  }
}'
write_json "$body_delta_known_dir/direct-request.json" '{
  "method": "POST",
  "target_url": "https://api.anthropic.com/v1/messages",
  "headers": {
    "accept": "text/event-stream",
    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
    "authorization": "Bearer <redacted>",
    "x-request-id": "req_body_good"
  }
}'

write_json "$body_delta_fail_dir/upstream-response.json" '{
  "status": 400,
  "provider_request_id": "req_body_fail_provider"
}'
write_json "$body_delta_known_dir/direct-response.json" '{
  "status": 200,
  "provider_request_id": "req_body_good_provider"
}'

run_diff \
  "$header_diff_fail_dir" \
  "$header_diff_known_dir" \
  "$TMP_DIR/header-diff-summary" \
  "$TMP_DIR/header-diff.stdout" \
  "$TMP_DIR/header-diff.stderr"

run_diff \
  "$provider_side_fail_dir" \
  "$provider_side_known_dir" \
  "$TMP_DIR/provider-side-summary" \
  "$TMP_DIR/provider-side.stdout" \
  "$TMP_DIR/provider-side.stderr"

run_diff \
  "$body_delta_fail_dir" \
  "$body_delta_known_dir" \
  "$TMP_DIR/body-delta-summary" \
  "$TMP_DIR/body-delta.stdout" \
  "$TMP_DIR/body-delta.stderr"

[[ -f "$TMP_DIR/header-diff-summary/summary.txt" ]]
[[ -f "$TMP_DIR/header-diff-summary/summary.json" ]]
grep -q '^mode=request_bundle_diff$' "$TMP_DIR/header-diff-summary/summary.txt"
grep -q '^classification=wire_delta_detected$' "$TMP_DIR/header-diff-summary/summary.txt"
grep -q '^raw_body_equal=false$' "$TMP_DIR/header-diff-summary/summary.txt"
grep -q '^canonical_json_body_equal=true$' "$TMP_DIR/header-diff-summary/summary.txt"
grep -q '^meaningful_header_difference_count=3$' "$TMP_DIR/header-diff-summary/summary.txt"
grep -q '^meaningful_header_names=anthropic-beta,user-agent,x-app$' "$TMP_DIR/header-diff-summary/summary.txt"
grep -q '^ignored_header_difference_count=1$' "$TMP_DIR/header-diff-summary/summary.txt"
grep -q '^ignored_header_names=x-request-id$' "$TMP_DIR/header-diff-summary/summary.txt"
grep -q '^provider_side_candidate=false$' "$TMP_DIR/header-diff-summary/summary.txt"
grep -q '^summary_file=' "$TMP_DIR/header-diff.stdout"

[[ -f "$TMP_DIR/provider-side-summary/summary.txt" ]]
grep -q '^classification=no_meaningful_request_delta_provider_side_candidate$' "$TMP_DIR/provider-side-summary/summary.txt"
grep -q '^meaningful_header_difference_count=0$' "$TMP_DIR/provider-side-summary/summary.txt"
grep -q '^provider_side_candidate=true$' "$TMP_DIR/provider-side-summary/summary.txt"

[[ -f "$TMP_DIR/body-delta-summary/summary.txt" ]]
grep -q '^classification=body_delta_detected$' "$TMP_DIR/body-delta-summary/summary.txt"
grep -q '^canonical_json_body_equal=false$' "$TMP_DIR/body-delta-summary/summary.txt"
grep -q '^body_difference_path_count=1$' "$TMP_DIR/body-delta-summary/summary.txt"
grep -q '^body_difference_paths=messages\[0\]\.content\[0\]\.text$' "$TMP_DIR/body-delta-summary/summary.txt"

node - "$TMP_DIR/header-diff-summary/summary.json" "$TMP_DIR/provider-side-summary/summary.json" "$TMP_DIR/body-delta-summary/summary.json" <<'NODE'
const fs = require('fs');

const [headerDiffPath, providerSidePath, bodyDeltaPath] = process.argv.slice(2);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const headerDiff = readJson(headerDiffPath);
const providerSide = readJson(providerSidePath);
const bodyDelta = readJson(bodyDeltaPath);

if (headerDiff.classification !== 'wire_delta_detected') {
  throw new Error('header-diff classification mismatch');
}
if (headerDiff.meaningfulHeaderDifferences.length !== 3) {
  throw new Error('header-diff meaningful header count mismatch');
}
if (!headerDiff.meaningfulHeaderDifferences.some((entry) => entry.header === 'x-app' && entry.kind === 'only_in_known_good')) {
  throw new Error('missing x-app diff');
}
if (providerSide.classification !== 'no_meaningful_request_delta_provider_side_candidate') {
  throw new Error('provider-side classification mismatch');
}
if (providerSide.providerSideCandidate !== true) {
  throw new Error('provider-side candidate flag mismatch');
}
if (bodyDelta.classification !== 'body_delta_detected') {
  throw new Error('body-delta classification mismatch');
}
if (!bodyDelta.bodyDifferences.some((entry) => entry.path === 'messages[0].content[0].text')) {
  throw new Error('body diff path missing');
}
NODE

missing_payload_dir="$TMP_DIR/missing-payload"
mkdir -p "$missing_payload_dir"
write_json "$missing_payload_dir/upstream-request.json" '{"method":"POST","target_url":"https://api.anthropic.com/v1/messages","headers":{}}'
write_json "$missing_payload_dir/upstream-response.json" '{"status":400}'

set +e
"$SCRIPT_PATH" "$missing_payload_dir" "$provider_side_known_dir" >"$TMP_DIR/missing.stdout" 2>"$TMP_DIR/missing.stderr"
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo 'expected missing payload bundle to fail' >&2
  exit 1
fi

grep -q 'missing payload.json' "$TMP_DIR/missing.stderr"

echo 'PASS: innies-compat-request-bundle-diff classifies exact first-pass request deltas'
