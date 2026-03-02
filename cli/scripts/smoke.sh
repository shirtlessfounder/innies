#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

export HOME="$TMP_DIR/home"
mkdir -p "$HOME/bin" "$HOME/.local/bin"
MOCK_BASE_URL="https://gateway.headroom.ai"

FAKE_CLAUDE_LOG="$TMP_DIR/fake_claude.log"
cat > "$HOME/bin/claude" << 'SH'
#!/usr/bin/env bash
set -euo pipefail
{
  echo "args:$*"
  echo "HEADROOM_ROUTE_MODE:${HEADROOM_ROUTE_MODE:-}"
  echo "HEADROOM_API_BASE_URL:${HEADROOM_API_BASE_URL:-}"
  echo "HEADROOM_PROXY_URL:${HEADROOM_PROXY_URL:-}"
  echo "HEADROOM_TOKEN:${HEADROOM_TOKEN:-}"
  echo "HEADROOM_CORRELATION_ID:${HEADROOM_CORRELATION_ID:-}"
} >> "$FAKE_CLAUDE_LOG"

if [[ "${1:-}" == "--check-pass-through" ]]; then
  echo '{"id":"msg_123","type":"message","content":[{"type":"text","text":"ok"}]}' > "$TMP_DIR/r200.json"
  echo '{"type":"error","error":{"type":"invalid_request_error","message":"bad input"}}' > "$TMP_DIR/r400.json"

  if grep -q '"requestId"' "$TMP_DIR/r200.json"; then
    echo "pass_through:bad_200_envelope_detected" >> "$FAKE_CLAUDE_LOG"
    exit 1
  fi

  if grep -q '"upstreamStatus"' "$TMP_DIR/r400.json"; then
    echo "pass_through:bad_400_envelope_detected" >> "$FAKE_CLAUDE_LOG"
    exit 1
  fi

  echo "pass_through:ok" >> "$FAKE_CLAUDE_LOG"
fi

if [[ "${1:-}" == "--check-idempotency-policy" ]]; then
  echo '{"code":"proxy_replay_not_supported","message":"Streaming requests cannot be idempotently replayed."}' > "$TMP_DIR/replay409.json"

  if ! grep -q '"code":"proxy_replay_not_supported"' "$TMP_DIR/replay409.json"; then
    echo "idempotency:missing_policy_code" >> "$FAKE_CLAUDE_LOG"
    exit 1
  fi

  if grep -q '"requestId"' "$TMP_DIR/replay409.json"; then
    echo "idempotency:unexpected_envelope_detected" >> "$FAKE_CLAUDE_LOG"
    exit 1
  fi

  echo "idempotency:ok" >> "$FAKE_CLAUDE_LOG"
fi

if [[ "${1:-}" == "--check-token-auth-failure" ]]; then
  echo '{"type":"error","error":{"type":"authentication_error","message":"token mode not enabled for org"}}' >&2
  exit 1
fi
SH
chmod +x "$HOME/bin/claude"

export PATH="$HOME/bin:$PATH"
export FAKE_CLAUDE_LOG
export TMP_DIR
export HEADROOM_CAPTURE_CLAUDE_OUTPUT=1

node "$ROOT_DIR/src/index.js" login --token hr_live_test --base-url "$MOCK_BASE_URL"
node "$ROOT_DIR/src/index.js" doctor
node "$ROOT_DIR/src/index.js" link claude
node "$ROOT_DIR/src/index.js" claude -- --version --foo bar
node "$ROOT_DIR/src/index.js" claude -- --check-pass-through
node "$ROOT_DIR/src/index.js" claude -- --check-idempotency-policy
if node "$ROOT_DIR/src/index.js" claude -- --check-token-auth-failure > "$TMP_DIR/token_auth_failure.out" 2>&1; then
  echo "smoke: expected token auth failure path to return non-zero"
  exit 1
fi

if [[ ! -f "$HOME/.innies/config.json" ]]; then
  echo "smoke: missing config.json"
  exit 1
fi

if [[ ! -x "$HOME/.local/bin/claude" ]]; then
  echo "smoke: missing claude wrapper"
  exit 1
fi

cat > "$HOME/bin/innies" << SH
#!/usr/bin/env bash
set -euo pipefail
exec node "$ROOT_DIR/src/index.js" "\$@"
SH
chmod +x "$HOME/bin/innies"

export PATH="$HOME/.local/bin:$HOME/bin:$PATH"
unset HEADROOM_CLAUDE_WRAPPED
"$HOME/.local/bin/claude" --via-wrapper

if ! grep -q 'args:--version --foo bar' "$FAKE_CLAUDE_LOG"; then
  echo "smoke: claude args not forwarded"
  exit 1
fi

if ! grep -q 'args:--via-wrapper' "$FAKE_CLAUDE_LOG"; then
  echo "smoke: wrapper invocation did not reach real claude binary"
  exit 1
fi

if ! grep -q "HEADROOM_PROXY_URL:$MOCK_BASE_URL/v1/proxy" "$FAKE_CLAUDE_LOG"; then
  echo "smoke: missing HEADROOM_PROXY_URL wiring"
  exit 1
fi

if ! grep -q 'HEADROOM_ROUTE_MODE:token' "$FAKE_CLAUDE_LOG"; then
  echo "smoke: missing explicit token route mode wiring"
  exit 1
fi

if ! grep -q 'HEADROOM_TOKEN:hr_live_test' "$FAKE_CLAUDE_LOG"; then
  echo "smoke: missing HEADROOM_TOKEN wiring"
  exit 1
fi

if ! grep -q 'pass_through:ok' "$FAKE_CLAUDE_LOG"; then
  echo "smoke: non-streaming pass-through compatibility check failed"
  exit 1
fi

if ! grep -q 'idempotency:ok' "$FAKE_CLAUDE_LOG"; then
  echo "smoke: idempotency compatibility check failed"
  exit 1
fi

if ! grep -q 'Innies hint: Token auth failed: token mode is not enabled for this org.' "$TMP_DIR/token_auth_failure.out"; then
  echo "smoke: token auth failure hint missing or unclear"
  exit 1
fi

if [[ "${HEADROOM_SMOKE_REAL_PROXY:-0}" == "1" ]]; then
  if [[ -z "${HEADROOM_SMOKE_API_URL:-}" || -z "${HEADROOM_SMOKE_API_KEY:-}" || -z "${HEADROOM_SMOKE_IDEMPOTENCY_KEY:-}" ]]; then
    echo "smoke: HEADROOM_SMOKE_REAL_PROXY=1 requires HEADROOM_SMOKE_API_URL, HEADROOM_SMOKE_API_KEY, HEADROOM_SMOKE_IDEMPOTENCY_KEY"
    exit 1
  fi

  REAL_HEADERS="$TMP_DIR/real_proxy_headers.txt"
  REAL_BODY="$TMP_DIR/real_proxy_body.json"
  REAL_STATUS=$(curl -sS -D "$REAL_HEADERS" -o "$REAL_BODY" -w "%{http_code}" \
    -X POST "${HEADROOM_SMOKE_API_URL%/}/v1/proxy/v1/messages" \
    -H "Authorization: Bearer $HEADROOM_SMOKE_API_KEY" \
    -H "Idempotency-Key: $HEADROOM_SMOKE_IDEMPOTENCY_KEY" \
    -H "Content-Type: application/json" \
    -d '{"provider":"anthropic","model":"claude-code","streaming":false,"payload":{"messages":[{"role":"user","content":"smoke"}]}}')

  if [[ "$REAL_STATUS" -lt 200 || "$REAL_STATUS" -gt 299 ]]; then
    echo "smoke: real proxy check failed with status $REAL_STATUS"
    cat "$REAL_BODY"
    exit 1
  fi

  if ! grep -qi '^x-innies-token-credential-id:' "$REAL_HEADERS"; then
    echo "smoke: real proxy check missing x-innies-token-credential-id header"
    cat "$REAL_HEADERS"
    exit 1
  fi

  echo "smoke: real token-route evidence ok"
fi

echo "smoke: passed"
