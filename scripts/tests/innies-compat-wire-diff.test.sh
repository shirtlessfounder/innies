#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="${ROOT_DIR}/scripts/innies-compat-wire-diff.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local file_path="$1"
  local expected="$2"
  if ! grep -Fq "$expected" "$file_path"; then
    echo "expected to find: $expected" >&2
    echo "--- ${file_path} ---" >&2
    cat "$file_path" >&2
    fail "missing expected content"
  fi
}

assert_not_contains() {
  local file_path="$1"
  local unexpected="$2"
  if grep -Fq "$unexpected" "$file_path"; then
    echo "did not expect to find: $unexpected" >&2
    echo "--- ${file_path} ---" >&2
    cat "$file_path" >&2
    fail "unexpected content present"
  fi
}

assert_file_exists() {
  local file_path="$1"
  [[ -f "$file_path" ]] || fail "expected file to exist: $file_path"
}

make_bundle() {
  local file_path="$1"
  local body_bytes="$2"
  local body_sha="$3"
  local beta="$4"
  local user_agent="$5"
  local request_id="$6"
  cat >"$file_path" <<EOF_JSON
{
  "method": "POST",
  "target_url": "https://api.anthropic.com/v1/messages",
  "request_id": "${request_id}",
  "body_bytes": ${body_bytes},
  "body_sha256": "${body_sha}",
  "headers": {
    "accept": "text/event-stream",
    "anthropic-beta": "${beta}",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "user-agent": "${user_agent}",
    "x-request-id": "${request_id}"
  }
}
EOF_JSON
}

test_identical_bundles() {
  local tmp_dir out_dir
  tmp_dir="$(mktemp -d)"
  out_dir="${tmp_dir}/out"

  make_bundle \
    "${tmp_dir}/left.json" \
    398262 \
    "1717a039bed013d162eb47daead7f7eea440bccc6fb2719b9233142976e9a093" \
    "fine-grained-tool-streaming-2025-05-14" \
    "OpenClawGateway/1.0" \
    "req_left"
  cp "${tmp_dir}/left.json" "${tmp_dir}/right.json"

  INNIES_WIRE_DIFF_OUT_DIR="$out_dir" "$SCRIPT_PATH" "${tmp_dir}/left.json" "${tmp_dir}/right.json"

  assert_file_exists "${out_dir}/summary.txt"
  assert_file_exists "${out_dir}/diff.json"
  assert_contains "${out_dir}/summary.txt" "body_match=true"
  assert_contains "${out_dir}/summary.txt" "body_bytes_match=true"
  assert_contains "${out_dir}/summary.txt" "changed_header_count=0"
  assert_contains "${out_dir}/summary.txt" "left_only_header_count=0"
  assert_contains "${out_dir}/summary.txt" "right_only_header_count=0"
  assert_not_contains "${out_dir}/summary.txt" "changed_headers="
}

test_symlink_invocation() {
  local tmp_dir out_dir symlink_dir symlink_path
  tmp_dir="$(mktemp -d)"
  out_dir="${tmp_dir}/out"
  symlink_dir="${tmp_dir}/bin"
  symlink_path="${symlink_dir}/innies-compat-wire-diff"

  mkdir -p "$symlink_dir"

  make_bundle \
    "${tmp_dir}/left.json" \
    398262 \
    "1717a039bed013d162eb47daead7f7eea440bccc6fb2719b9233142976e9a093" \
    "fine-grained-tool-streaming-2025-05-14" \
    "OpenClawGateway/1.0" \
    "req_left"
  cp "${tmp_dir}/left.json" "${tmp_dir}/right.json"
  ln -sf "$SCRIPT_PATH" "$symlink_path"

  INNIES_WIRE_DIFF_OUT_DIR="$out_dir" "$symlink_path" "${tmp_dir}/left.json" "${tmp_dir}/right.json"

  assert_contains "${out_dir}/summary.txt" "body_match=true"
}

test_detects_deltas() {
  local tmp_dir out_dir
  tmp_dir="$(mktemp -d)"
  out_dir="${tmp_dir}/out"

  make_bundle \
    "${tmp_dir}/left.json" \
    398262 \
    "1717a039bed013d162eb47daead7f7eea440bccc6fb2719b9233142976e9a093" \
    "fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20" \
    "OpenClawGateway/1.0" \
    "req_left"
  make_bundle \
    "${tmp_dir}/right.json" \
    398999 \
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
    "fine-grained-tool-streaming-2025-05-14" \
    "Claude/1.0" \
    "req_right"

  jq 'del(.headers["x-request-id"]) | .headers["x-extra-direct"] = "true"' \
    "${tmp_dir}/right.json" > "${tmp_dir}/right-mutated.json"
  mv "${tmp_dir}/right-mutated.json" "${tmp_dir}/right.json"

  INNIES_WIRE_DIFF_OUT_DIR="$out_dir" "$SCRIPT_PATH" "${tmp_dir}/left.json" "${tmp_dir}/right.json"

  assert_contains "${out_dir}/summary.txt" "body_match=false"
  assert_contains "${out_dir}/summary.txt" "body_bytes_match=false"
  assert_contains "${out_dir}/summary.txt" "changed_header_count=2"
  assert_contains "${out_dir}/summary.txt" "left_only_header_count=1"
  assert_contains "${out_dir}/summary.txt" "right_only_header_count=1"
  assert_contains "${out_dir}/summary.txt" "changed_headers=anthropic-beta,user-agent"
  assert_contains "${out_dir}/summary.txt" "left_only_headers=x-request-id"
  assert_contains "${out_dir}/summary.txt" "right_only_headers=x-extra-direct"
  assert_contains "${out_dir}/diff.json" "\"body_sha256\""
  assert_contains "${out_dir}/diff.json" "\"x-extra-direct\""
}

test_missing_input_fails() {
  local tmp_dir stderr_file
  tmp_dir="$(mktemp -d)"
  stderr_file="${tmp_dir}/stderr.txt"

  if "$SCRIPT_PATH" "${tmp_dir}/missing-left.json" "${tmp_dir}/missing-right.json" 2>"${stderr_file}"; then
    fail "expected missing-input invocation to fail"
  fi

  assert_contains "${stderr_file}" "error: request bundle not found"
}

test_identical_bundles
test_symlink_invocation
test_detects_deltas
test_missing_input_fails

echo "PASS: innies-compat-wire-diff"
