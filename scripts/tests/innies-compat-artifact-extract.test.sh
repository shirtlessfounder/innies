#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${ROOT_DIR}/scripts/innies-compat-artifact-extract.sh"

fail() {
  echo "not ok - $*" >&2
  exit 1
}

assert_file_contains() {
  local path="$1"
  local expected="$2"

  if ! grep -Fq "$expected" "$path"; then
    echo "expected to find [$expected] in $path" >&2
    cat "$path" >&2
    exit 1
  fi
}

assert_json_field() {
  local path="$1"
  local field="$2"
  local expected="$3"
  local actual

  actual="$(node -e '
    const fs = require("node:fs");
    const input = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const field = process.argv[2].split(".");
    let value = input;
    for (const part of field) {
      value = value?.[part];
    }
    process.stdout.write(value === undefined ? "" : String(value));
  ' "$path" "$field")"

  if [[ "$actual" != "$expected" ]]; then
    fail "$path field $field expected [$expected] got [$actual]"
  fi
}

run_happy_path_test() {
  local tmp_dir artifact out_dir
  tmp_dir="$(mktemp -d)"
  artifact="${tmp_dir}/artifact.log"
  out_dir="${tmp_dir}/out"

  cat >"$artifact" <<'EOF'
Mar 17 13:22:53 sf-prod bash[269534]: [compat-invalid-request-debug-json-chunk] {
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_index: 0,
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_count: 1,
Mar 17 13:22:53 sf-prod bash[269534]:   json: '{"request_id":"req_target","provider":"anthropic","anthropic_beta":"caller-beta","request_shape":{"message_count":2}}'
Mar 17 13:22:53 sf-prod bash[269534]: }
Mar 17 13:22:53 sf-prod bash[269534]: [compat-invalid-request-debug-json-chunk] {
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_index: 0,
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_count: 1,
Mar 17 13:22:53 sf-prod bash[269534]:   json: '{"request_id":"req_other","provider":"anthropic","anthropic_beta":"other-beta","request_shape":{"message_count":9}}'
Mar 17 13:22:53 sf-prod bash[269534]: }
Mar 17 13:22:53 sf-prod bash[269534]: [compat-invalid-request-payload-json-chunk] {
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_index: 0,
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_count: 1,
Mar 17 13:22:53 sf-prod bash[269534]:   json: '{"request_id":"req_other","model":"beta-b","payload":{"messages":[{"role":"user","content":"wrong"}]}}'
Mar 17 13:22:53 sf-prod bash[269534]: }
Mar 17 13:22:53 sf-prod bash[269534]: [compat-upstream-request-json-chunk] {
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_index: 0,
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_count: 1,
Mar 17 13:22:53 sf-prod bash[269534]:   json: '{"request_id":"req_target","provider":"anthropic","body_sha256":"abc123","body_bytes":42,"headers":{"anthropic-beta":"caller-beta,oauth-2025-04-20","user-agent":"OpenClawGateway/1.0","x-request-id":"req_target"}}'
Mar 17 13:22:53 sf-prod bash[269534]: }
Mar 17 13:22:53 sf-prod bash[269534]: [compat-upstream-response-json-chunk] {
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_index: 0,
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_count: 1,
Mar 17 13:22:53 sf-prod bash[269534]:   json: `{"request_id":"req_target","upstream_status":400,"parsed_body":{"request_id":"up_req_123"}}`
Mar 17 13:22:53 sf-prod bash[269534]: }
Mar 17 13:22:53 sf-prod bash[269534]: [compat-invalid-request-payload-json-chunk] {
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_index: 0,
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_count: 2,
Mar 17 13:22:53 sf-prod bash[269534]:   json: '{"request_id":"req_target","model":"alpha-model","payload":{"messages":[{"role":"user","content":"hel'
Mar 17 13:22:53 sf-prod bash[269534]: }
Mar 17 13:22:53 sf-prod bash[269534]: [compat-invalid-request-payload-json-chunk] {
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_index: 1,
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_count: 2,
Mar 17 13:22:53 sf-prod bash[269534]:   json: 'lo"}],"stream":true}}'
Mar 17 13:22:53 sf-prod bash[269534]: }
EOF

  INNIES_EXTRACT_OUT_DIR="$out_dir" "$SCRIPT" "$artifact" req_target

  assert_json_field "$out_dir/ingress.json" "request_id" "req_target"
  assert_json_field "$out_dir/ingress.json" "anthropic_beta" "caller-beta"
  assert_json_field "$out_dir/payload.json" "messages.0.content" "hello"
  assert_json_field "$out_dir/payload.json" "stream" "true"
  assert_json_field "$out_dir/invalid-request-payload.json" "model" "alpha-model"
  assert_json_field "$out_dir/upstream-request.json" "headers.user-agent" "OpenClawGateway/1.0"
  assert_json_field "$out_dir/upstream-response.json" "parsed_body.request_id" "up_req_123"
  assert_file_contains "$out_dir/summary.txt" "request_id=req_target"
  assert_file_contains "$out_dir/summary.txt" "body_sha256=abc123"
  assert_file_contains "$out_dir/summary.txt" "ingress_anthropic_beta=caller-beta"
  assert_file_contains "$out_dir/summary.txt" "upstream_anthropic_beta=caller-beta,oauth-2025-04-20"
  assert_file_contains "$out_dir/summary.txt" "upstream_request_id=up_req_123"
  assert_file_contains "$out_dir/summary.txt" "payload_available=true"
}

run_missing_request_test() {
  local tmp_dir artifact
  tmp_dir="$(mktemp -d)"
  artifact="${tmp_dir}/artifact.log"

  cat >"$artifact" <<'EOF'
Mar 17 13:22:53 sf-prod bash[269534]: [compat-upstream-request-json-chunk] {
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_index: 0,
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_count: 1,
Mar 17 13:22:53 sf-prod bash[269534]:   json: '{"request_id":"req_other","provider":"anthropic"}'
Mar 17 13:22:53 sf-prod bash[269534]: }
EOF

  if "$SCRIPT" "$artifact" req_missing >"${tmp_dir}/stdout.txt" 2>"${tmp_dir}/stderr.txt"; then
    fail "expected missing request extraction to fail"
  fi

  assert_file_contains "${tmp_dir}/stderr.txt" "request_id req_missing not found"
}

run_malicious_literal_test() {
  local tmp_dir artifact marker
  tmp_dir="$(mktemp -d)"
  artifact="${tmp_dir}/artifact.log"
  marker="${tmp_dir}/marker.txt"

  cat >"$artifact" <<EOF
Mar 17 13:22:53 sf-prod bash[269534]: [compat-upstream-request-json-chunk] {
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_index: 0,
Mar 17 13:22:53 sf-prod bash[269534]:   chunk_count: 1,
Mar 17 13:22:53 sf-prod bash[269534]:   json: Function("return process")().getBuiltinModule("node:fs").writeFileSync("${marker}","owned")
Mar 17 13:22:53 sf-prod bash[269534]: }
EOF

  if "$SCRIPT" "$artifact" req_target >"${tmp_dir}/stdout.txt" 2>"${tmp_dir}/stderr.txt"; then
    fail "expected malicious artifact extraction to fail"
  fi

  [[ ! -e "$marker" ]] || fail "malicious artifact executed code"
  assert_file_contains "${tmp_dir}/stderr.txt" "unsupported json literal"
}

run_happy_path_test
run_missing_request_test
run_malicious_literal_test

echo "ok - innies-compat-artifact-extract"
