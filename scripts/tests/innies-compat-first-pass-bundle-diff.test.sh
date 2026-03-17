#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/innies-compat-first-pass-bundle-diff.sh"
TMP_DIR="$(mktemp -d)"
SINGLE_OUT_DIR="$TMP_DIR/single-out"
DOUBLE_OUT_DIR="$TMP_DIR/double-out"
SINGLE_STDOUT="$TMP_DIR/single-stdout.txt"
SINGLE_STDERR="$TMP_DIR/single-stderr.txt"
DOUBLE_STDOUT="$TMP_DIR/double-stdout.txt"
DOUBLE_STDERR="$TMP_DIR/double-stderr.txt"
BUNDLE_DIR="$TMP_DIR/issue80-bundle"
DIRECT_DIR="$TMP_DIR/direct-bundle"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$BUNDLE_DIR" "$DIRECT_DIR"

cat >"$BUNDLE_DIR/ingress.json" <<'JSON'
{
  "requestId": "req_issue80_ingress",
  "anthropicBeta": "fine-grained-tool-streaming-2025-05-14",
  "anthropicVersion": "2023-06-01",
  "requestIdHeader": null,
  "payloadAvailable": true
}
JSON

cat >"$BUNDLE_DIR/payload.json" <<'JSON'
{
  "model": "claude-opus-4-6",
  "stream": true,
  "max_tokens": 16,
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "hi"
        }
      ]
    }
  ]
}
JSON

cat >"$BUNDLE_DIR/upstream-request.json" <<'JSON'
{
  "attempt_no": 1,
  "body_bytes": 121,
  "body_sha256": "sha-bundle-upstream",
  "headers": {
    "accept": "text/event-stream",
    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": "2023-06-01",
    "authorization": "Bearer <redacted>",
    "content-type": "application/json",
    "user-agent": "OpenClawGateway/1.0",
    "x-app": "cli",
    "x-request-id": "req_issue80_upstream"
  },
  "method": "POST",
  "provider": "anthropic",
  "request_id": "req_issue80_upstream",
  "target_url": "https://api.anthropic.com/v1/messages"
}
JSON

cat >"$BUNDLE_DIR/summary.txt" <<'EOF'
request_id=req_issue80_upstream
attempt_no=1
provider=anthropic
proxied_path=/v1/messages
target_url=https://api.anthropic.com/v1/messages
body_bytes=121
body_sha256=sha-bundle-upstream
upstream_status=400
provider_request_id=req_upstream_failure
payload_available=true
ingress_anthropic_beta=fine-grained-tool-streaming-2025-05-14
ingress_anthropic_version=2023-06-01
upstream_anthropic_beta=fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14
upstream_user_agent=OpenClawGateway/1.0
EOF

cat >"$DIRECT_DIR/payload.json" <<'JSON'
{
  "messages": [
    {
      "content": [
        {
          "text": "hi",
          "type": "text"
        }
      ],
      "role": "user"
    }
  ],
  "max_tokens": 16,
  "model": "claude-opus-4-6",
  "stream": true
}
JSON

cat >"$DIRECT_DIR/upstream-request.json" <<'JSON'
{
  "attempt_no": 1,
  "body_bytes": 121,
  "body_sha256": "sha-direct",
  "headers": {
    "accept": "text/event-stream",
    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": "2023-06-01",
    "authorization": "Bearer <redacted>",
    "content-type": "application/json",
    "user-agent": "OpenClawGateway/1.0",
    "x-app": "cli"
  },
  "method": "POST",
  "provider": "anthropic",
  "request_id": "req_direct_good",
  "target_url": "https://api.anthropic.com/v1/messages"
}
JSON

set +e
INNIES_DIFF_OUT_DIR="$SINGLE_OUT_DIR" \
"$SCRIPT_PATH" "$BUNDLE_DIR" >"$SINGLE_STDOUT" 2>"$SINGLE_STDERR"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  cat "$SINGLE_STDERR"
  exit 1
fi

[[ -f "$SINGLE_OUT_DIR/summary.txt" ]]
[[ -f "$SINGLE_OUT_DIR/header-diff.txt" ]]
[[ -f "$SINGLE_OUT_DIR/body-diff.txt" ]]

grep -q '^left_label=issue80-bundle#ingress$' "$SINGLE_OUT_DIR/summary.txt"
grep -q '^right_label=issue80-bundle#upstream$' "$SINGLE_OUT_DIR/summary.txt"
grep -q '^header_only_in_right=accept,anthropic-dangerous-direct-browser-access,authorization,content-type,user-agent,x-app,x-request-id$' "$SINGLE_OUT_DIR/summary.txt"
grep -q '^header_value_mismatches=anthropic-beta$' "$SINGLE_OUT_DIR/summary.txt"
grep -q '^payload_canonical_equal=true$' "$SINGLE_OUT_DIR/summary.txt"
grep -q '^body_sha256_left=sha-bundle-upstream$' "$SINGLE_OUT_DIR/summary.txt"
grep -q '^body_sha256_right=sha-bundle-upstream$' "$SINGLE_OUT_DIR/summary.txt"
grep -q 'left: fine-grained-tool-streaming-2025-05-14$' "$SINGLE_OUT_DIR/header-diff.txt"
grep -q 'right: fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14$' "$SINGLE_OUT_DIR/header-diff.txt"
grep -q '^payload canonical json matches$' "$SINGLE_OUT_DIR/body-diff.txt"

set +e
INNIES_DIFF_OUT_DIR="$DOUBLE_OUT_DIR" \
"$SCRIPT_PATH" "$BUNDLE_DIR#upstream" "$DIRECT_DIR" >"$DOUBLE_STDOUT" 2>"$DOUBLE_STDERR"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  cat "$DOUBLE_STDERR"
  exit 1
fi

grep -q '^left_label=issue80-bundle#upstream$' "$DOUBLE_OUT_DIR/summary.txt"
grep -q '^right_label=direct-bundle#upstream$' "$DOUBLE_OUT_DIR/summary.txt"
grep -q '^header_only_in_left=x-request-id$' "$DOUBLE_OUT_DIR/summary.txt"
grep -q '^header_value_mismatches=anthropic-beta$' "$DOUBLE_OUT_DIR/summary.txt"
grep -q '^body_sha256_left=sha-bundle-upstream$' "$DOUBLE_OUT_DIR/summary.txt"
grep -q '^body_sha256_right=sha-direct$' "$DOUBLE_OUT_DIR/summary.txt"
grep -q '^payload_canonical_equal=true$' "$DOUBLE_OUT_DIR/summary.txt"
