#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-first-pass-evidence.sh"

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

run_happy_path_test() {
  local tmp_dir artifact out_dir extract_stub diff_stub stdout_file stderr_file
  tmp_dir="$(mktemp -d)"
  artifact="${tmp_dir}/response.html"
  out_dir="${tmp_dir}/evidence"
  extract_stub="${tmp_dir}/extract.sh"
  diff_stub="${tmp_dir}/diff.sh"
  stdout_file="${tmp_dir}/stdout.txt"
  stderr_file="${tmp_dir}/stderr.txt"

  touch "$artifact"

  cat >"$extract_stub" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$INNIES_EXTRACT_OUT_DIR"
printf 'artifact=%s\nrequest_id=%s\n' "$1" "$2" >"$INNIES_EXTRACT_OUT_DIR/invocation.txt"
cat >"$INNIES_EXTRACT_OUT_DIR/summary.txt" <<'SUM'
request_id=req_target
body_sha256=sha_issue80
body_bytes=398262
upstream_status=400
ingress_anthropic_beta=fine-grained-tool-streaming-2025-05-14
upstream_anthropic_beta=fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14
upstream_user_agent=OpenClawGateway/1.0
SUM
printf 'output_dir=%s\n' "$INNIES_EXTRACT_OUT_DIR"
EOF
  chmod +x "$extract_stub"

  cat >"$diff_stub" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$INNIES_DIFF_OUT_DIR"
printf 'left=%s\nright=%s\n' "$1" "${2:-}" >"$INNIES_DIFF_OUT_DIR/invocation.txt"
cat >"$INNIES_DIFF_OUT_DIR/summary.txt" <<'SUM'
left_label=extract#ingress
right_label=extract#upstream
header_only_in_right=accept,anthropic-dangerous-direct-browser-access,authorization,content-type,user-agent,x-app,x-request-id
header_value_mismatches=anthropic-beta
payload_canonical_equal=true
SUM
printf 'wrote diff artifacts to %s\n' "$INNIES_DIFF_OUT_DIR"
EOF
  chmod +x "$diff_stub"

  INNIES_EVIDENCE_OUT_DIR="$out_dir" \
  INNIES_ARTIFACT_EXTRACT_BIN="$extract_stub" \
  INNIES_BUNDLE_DIFF_BIN="$diff_stub" \
  "$SCRIPT_PATH" "$artifact" req_target >"$stdout_file" 2>"$stderr_file"

  [[ -f "$out_dir/summary.txt" ]] || fail "expected merged summary"
  assert_file_contains "$out_dir/extract/invocation.txt" "artifact=$artifact"
  assert_file_contains "$out_dir/extract/invocation.txt" "request_id=req_target"
  assert_file_contains "$out_dir/diff/invocation.txt" "left=$out_dir/extract"
  assert_file_contains "$out_dir/summary.txt" "artifact_path=$artifact"
  assert_file_contains "$out_dir/summary.txt" "request_id=req_target"
  assert_file_contains "$out_dir/summary.txt" "body_sha256=sha_issue80"
  assert_file_contains "$out_dir/summary.txt" "upstream_user_agent=OpenClawGateway/1.0"
  assert_file_contains "$out_dir/summary.txt" "header_value_mismatches=anthropic-beta"
  assert_file_contains "$out_dir/summary.txt" "payload_canonical_equal=true"
  assert_file_contains "$out_dir/summary.txt" "extract_dir=$out_dir/extract"
  assert_file_contains "$out_dir/summary.txt" "diff_dir=$out_dir/diff"
  assert_file_contains "$stdout_file" "summary_file=$out_dir/summary.txt"
}

run_extract_failure_test() {
  local tmp_dir artifact out_dir extract_stub diff_stub stdout_file stderr_file
  tmp_dir="$(mktemp -d)"
  artifact="${tmp_dir}/response.html"
  out_dir="${tmp_dir}/evidence"
  extract_stub="${tmp_dir}/extract.sh"
  diff_stub="${tmp_dir}/diff.sh"
  stdout_file="${tmp_dir}/stdout.txt"
  stderr_file="${tmp_dir}/stderr.txt"

  touch "$artifact"

  cat >"$extract_stub" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "extract failed intentionally" >&2
exit 23
EOF
  chmod +x "$extract_stub"

  cat >"$diff_stub" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "diff should not run" >"${TMPDIR:-/tmp}/innies-compat-first-pass-evidence-diff-ran"
exit 99
EOF
  chmod +x "$diff_stub"

  rm -f "${TMPDIR:-/tmp}/innies-compat-first-pass-evidence-diff-ran"

  if INNIES_EVIDENCE_OUT_DIR="$out_dir" \
    INNIES_ARTIFACT_EXTRACT_BIN="$extract_stub" \
    INNIES_BUNDLE_DIFF_BIN="$diff_stub" \
    "$SCRIPT_PATH" "$artifact" req_target >"$stdout_file" 2>"$stderr_file"; then
    fail "expected wrapper to fail when extraction fails"
  fi

  assert_file_contains "$stderr_file" "extract failed intentionally"
  [[ ! -e "${TMPDIR:-/tmp}/innies-compat-first-pass-evidence-diff-ran" ]] || fail "diff helper ran after extract failure"
}

run_direct_happy_path_test() {
  local tmp_dir artifact out_dir extract_stub diff_stub direct_stub headers_tsv stdout_file stderr_file diff_log
  tmp_dir="$(mktemp -d)"
  artifact="${tmp_dir}/response.html"
  out_dir="${tmp_dir}/evidence"
  extract_stub="${tmp_dir}/extract.sh"
  diff_stub="${tmp_dir}/diff.sh"
  direct_stub="${tmp_dir}/direct.sh"
  headers_tsv="${tmp_dir}/direct-headers.tsv"
  stdout_file="${tmp_dir}/stdout.txt"
  stderr_file="${tmp_dir}/stderr.txt"
  diff_log="${tmp_dir}/diff.log"

  touch "$artifact"

  cat >"$headers_tsv" <<'EOF'
accept	text/event-stream
anthropic-beta	fine-grained-tool-streaming-2025-05-14
anthropic-version	2023-06-01
user-agent	OpenClawGateway/1.0
EOF

  cat >"$extract_stub" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$INNIES_EXTRACT_OUT_DIR"
printf 'artifact=%s\nrequest_id=%s\n' "$1" "$2" >"$INNIES_EXTRACT_OUT_DIR/invocation.txt"
cat >"$INNIES_EXTRACT_OUT_DIR/payload.json" <<'JSON'
{"model":"claude-opus-4-6","stream":true}
JSON
cat >"$INNIES_EXTRACT_OUT_DIR/summary.txt" <<'SUM'
request_id=req_target
body_sha256=sha_issue80
body_bytes=398262
payload_available=true
upstream_status=400
SUM
printf 'output_dir=%s\n' "$INNIES_EXTRACT_OUT_DIR"
EOF
  chmod +x "$extract_stub"

  cat >"$diff_stub" <<EOF
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "\$INNIES_DIFF_OUT_DIR"
printf 'left=%s\nright=%s\nout=%s\n' "\$1" "\${2:-}" "\$INNIES_DIFF_OUT_DIR" >>"$diff_log"
case "\$INNIES_DIFF_OUT_DIR" in
  */diff)
    cat >"\$INNIES_DIFF_OUT_DIR/summary.txt" <<'SUM'
left_label=extract#ingress
right_label=extract#upstream
header_value_mismatches=anthropic-beta
payload_canonical_equal=true
SUM
    ;;
  */direct-diff)
    cat >"\$INNIES_DIFF_OUT_DIR/summary.txt" <<'SUM'
left_label=extract#upstream
right_label=direct#upstream
header_value_mismatches=anthropic-version,user-agent
payload_canonical_equal=true
SUM
    ;;
  *)
    echo "unexpected diff dir: \$INNIES_DIFF_OUT_DIR" >&2
    exit 88
    ;;
esac
printf 'wrote diff artifacts to %s\n' "\$INNIES_DIFF_OUT_DIR"
EOF
  chmod +x "$diff_stub"

  cat >"$direct_stub" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$INNIES_DIRECT_BUNDLE_OUT_DIR"
printf 'payload=%s\nheaders=%s\n' "$1" "$2" >"$INNIES_DIRECT_BUNDLE_OUT_DIR/invocation.txt"
cat >"$INNIES_DIRECT_BUNDLE_OUT_DIR/summary.txt" <<'SUM'
request_id=req_direct
target_url=https://api.anthropic.com/v1/messages
direct_status=200
provider_request_id=req_direct_provider
direct_access_token_source=claude_code_oauth_token
anthropic_beta=fine-grained-tool-streaming-2025-05-14
SUM
printf 'summary_file=%s\n' "$INNIES_DIRECT_BUNDLE_OUT_DIR/summary.txt"
EOF
  chmod +x "$direct_stub"

  INNIES_EVIDENCE_OUT_DIR="$out_dir" \
  INNIES_ARTIFACT_EXTRACT_BIN="$extract_stub" \
  INNIES_BUNDLE_DIFF_BIN="$diff_stub" \
  INNIES_DIRECT_REQUEST_BUNDLE_BIN="$direct_stub" \
  "$SCRIPT_PATH" "$artifact" req_target "$headers_tsv" >"$stdout_file" 2>"$stderr_file"

  [[ -f "$out_dir/summary.txt" ]] || fail "expected merged summary for direct mode"
  assert_file_contains "$out_dir/direct/invocation.txt" "payload=$out_dir/extract/payload.json"
  assert_file_contains "$out_dir/direct/invocation.txt" "headers=$headers_tsv"
  assert_file_contains "$diff_log" "left=$out_dir/extract"
  assert_file_contains "$diff_log" "right="
  assert_file_contains "$diff_log" "left=$out_dir/extract#upstream"
  assert_file_contains "$diff_log" "right=$out_dir/direct#upstream"
  assert_file_contains "$out_dir/summary.txt" "direct_headers_tsv_path=$headers_tsv"
  assert_file_contains "$out_dir/summary.txt" "direct_request_id=req_direct"
  assert_file_contains "$out_dir/summary.txt" "direct_target_url=https://api.anthropic.com/v1/messages"
  assert_file_contains "$out_dir/summary.txt" "compat_upstream_vs_direct_left_label=extract#upstream"
  assert_file_contains "$out_dir/summary.txt" "compat_upstream_vs_direct_right_label=direct#upstream"
  assert_file_contains "$out_dir/summary.txt" "compat_upstream_vs_direct_header_value_mismatches=anthropic-version,user-agent"
  assert_file_contains "$out_dir/summary.txt" "direct_dir=$out_dir/direct"
  assert_file_contains "$out_dir/summary.txt" "direct_diff_dir=$out_dir/direct-diff"
  assert_file_contains "$stdout_file" "summary_file=$out_dir/summary.txt"
}

run_direct_missing_payload_test() {
  local tmp_dir artifact out_dir extract_stub diff_stub direct_stub headers_tsv stdout_file stderr_file direct_marker
  tmp_dir="$(mktemp -d)"
  artifact="${tmp_dir}/response.html"
  out_dir="${tmp_dir}/evidence"
  extract_stub="${tmp_dir}/extract.sh"
  diff_stub="${tmp_dir}/diff.sh"
  direct_stub="${tmp_dir}/direct.sh"
  headers_tsv="${tmp_dir}/direct-headers.tsv"
  stdout_file="${tmp_dir}/stdout.txt"
  stderr_file="${tmp_dir}/stderr.txt"
  direct_marker="${tmp_dir}/direct-ran"

  touch "$artifact"

  cat >"$headers_tsv" <<'EOF'
accept	text/event-stream
EOF

  cat >"$extract_stub" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$INNIES_EXTRACT_OUT_DIR"
cat >"$INNIES_EXTRACT_OUT_DIR/summary.txt" <<'SUM'
request_id=req_target
body_sha256=sha_issue80
body_bytes=398262
payload_available=false
SUM
EOF
  chmod +x "$extract_stub"

  cat >"$diff_stub" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$INNIES_DIFF_OUT_DIR"
cat >"$INNIES_DIFF_OUT_DIR/summary.txt" <<'SUM'
left_label=extract#ingress
right_label=extract#upstream
SUM
EOF
  chmod +x "$diff_stub"

  cat >"$direct_stub" <<EOF
#!/usr/bin/env bash
set -euo pipefail
echo "direct helper ran unexpectedly" >"$direct_marker"
exit 99
EOF
  chmod +x "$direct_stub"

  if INNIES_EVIDENCE_OUT_DIR="$out_dir" \
    INNIES_ARTIFACT_EXTRACT_BIN="$extract_stub" \
    INNIES_BUNDLE_DIFF_BIN="$diff_stub" \
    INNIES_DIRECT_REQUEST_BUNDLE_BIN="$direct_stub" \
    "$SCRIPT_PATH" "$artifact" req_target "$headers_tsv" >"$stdout_file" 2>"$stderr_file"; then
    fail "expected wrapper to fail when extracted payload is missing"
  fi

  assert_file_contains "$stderr_file" "extract helper did not write payload"
  [[ ! -e "$direct_marker" ]] || fail "direct helper ran without payload"
}

run_happy_path_test
run_extract_failure_test
run_direct_happy_path_test
run_direct_missing_payload_test

echo "ok - innies-compat-first-pass-evidence"
