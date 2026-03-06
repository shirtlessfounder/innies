#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

export HOME="$TMP_DIR/home"
mkdir -p "$HOME/bin" "$HOME/.local/bin"
MOCK_BASE_URL="https://gateway.innies.ai"

FAKE_CLAUDE_LOG="$TMP_DIR/fake_claude.log"
FAKE_CODEX_LOG="$TMP_DIR/fake_codex.log"
cat > "$HOME/bin/claude" << 'SH'
#!/usr/bin/env bash
set -euo pipefail
{
  echo "args:$*"
  echo "INNIES_ROUTE_MODE:${INNIES_ROUTE_MODE:-}"
  echo "INNIES_API_BASE_URL:${INNIES_API_BASE_URL:-}"
  echo "INNIES_PROXY_URL:${INNIES_PROXY_URL:-}"
  echo "INNIES_TOKEN:${INNIES_TOKEN:-}"
  echo "INNIES_CORRELATION_ID:${INNIES_CORRELATION_ID:-}"
} >> "$FAKE_CLAUDE_LOG"

if printf '%s\n' "$@" | grep -qx -- '--check-pass-through'; then
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

if printf '%s\n' "$@" | grep -qx -- '--check-idempotency-policy'; then
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

if printf '%s\n' "$@" | grep -qx -- '--check-token-auth-failure'; then
  echo '{"type":"error","error":{"type":"authentication_error","message":"token mode not enabled for org"}}' >&2
  exit 1
fi
SH
chmod +x "$HOME/bin/claude"

cat > "$HOME/bin/codex" << 'SH'
#!/usr/bin/env bash
set -euo pipefail
{
  for arg in "$@"; do
    echo "arg:$arg"
  done
  echo "INNIES_ROUTE_MODE:${INNIES_ROUTE_MODE:-}"
  echo "INNIES_API_BASE_URL:${INNIES_API_BASE_URL:-}"
  echo "INNIES_PROXY_URL:${INNIES_PROXY_URL:-}"
  echo "INNIES_TOKEN:${INNIES_TOKEN:-}"
  echo "INNIES_CORRELATION_ID:${INNIES_CORRELATION_ID:-}"
  echo "INNIES_PROVIDER_PIN:${INNIES_PROVIDER_PIN:-}"
  echo "OPENAI_API_KEY:${OPENAI_API_KEY:-}"
  echo "OPENAI_BASE_URL:${OPENAI_BASE_URL:-}"
} >> "$FAKE_CODEX_LOG"

if printf '%s\n' "$@" | grep -qx -- '--check-token-auth-failure'; then
  echo '{"error":{"message":"token mode not enabled for org"}}' >&2
  exit 1
fi

echo "codex-help-stub"
SH
chmod +x "$HOME/bin/codex"

export PATH="$HOME/bin:$PATH"
export FAKE_CLAUDE_LOG
export FAKE_CODEX_LOG
export TMP_DIR
export INNIES_CAPTURE_CLAUDE_OUTPUT=1
export INNIES_CAPTURE_CODEX_OUTPUT=1

node "$ROOT_DIR/src/index.js" login --token in_live_test --base-url "$MOCK_BASE_URL"
node "$ROOT_DIR/src/index.js" doctor > "$TMP_DIR/doctor.out"
node "$ROOT_DIR/src/index.js" link claude
node "$ROOT_DIR/src/index.js" claude -- --version --foo bar
node "$ROOT_DIR/src/index.js" codex -- --help > "$TMP_DIR/codex.out"
if node "$ROOT_DIR/src/index.js" codex -- --check-token-auth-failure > "$TMP_DIR/codex_token_auth_failure.out" 2>&1; then
  echo "smoke: expected codex token auth failure path to return non-zero"
  exit 1
fi
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

if ! grep -q '^OK  claude_binary' "$TMP_DIR/doctor.out"; then
  echo "smoke: doctor did not report claude_binary as ready"
  cat "$TMP_DIR/doctor.out"
  exit 1
fi

if ! grep -q '^OK  codex_binary' "$TMP_DIR/doctor.out"; then
  echo "smoke: doctor did not report codex_binary as ready"
  cat "$TMP_DIR/doctor.out"
  exit 1
fi

cat > "$HOME/bin/innies" << SH
#!/usr/bin/env bash
set -euo pipefail
exec node "$ROOT_DIR/src/index.js" "\$@"
SH
chmod +x "$HOME/bin/innies"

export PATH="$HOME/.local/bin:$HOME/bin:$PATH"
unset INNIES_CLAUDE_WRAPPED
"$HOME/.local/bin/claude" --via-wrapper

if ! grep -q 'args:.*--version --foo bar' "$FAKE_CLAUDE_LOG"; then
  echo "smoke: claude args not forwarded"
  exit 1
fi

if ! grep -q 'args:.*--via-wrapper' "$FAKE_CLAUDE_LOG"; then
  echo "smoke: wrapper invocation did not reach real claude binary"
  exit 1
fi

if ! grep -q "INNIES_PROXY_URL:$MOCK_BASE_URL/v1/proxy" "$FAKE_CLAUDE_LOG"; then
  echo "smoke: missing INNIES_PROXY_URL wiring"
  exit 1
fi

if ! grep -q 'INNIES_ROUTE_MODE:token' "$FAKE_CLAUDE_LOG"; then
  echo "smoke: missing explicit token route mode wiring"
  exit 1
fi

if ! grep -q 'INNIES_TOKEN:in_live_test' "$FAKE_CLAUDE_LOG"; then
  echo "smoke: missing INNIES_TOKEN wiring"
  exit 1
fi

if ! grep -q 'arg:model_provider="innies"' "$FAKE_CODEX_LOG"; then
  echo "smoke: missing codex provider override"
  exit 1
fi

if ! grep -q "arg:model_providers.innies.base_url=\"$MOCK_BASE_URL/v1/proxy/v1\"" "$FAKE_CODEX_LOG"; then
  echo "smoke: missing codex base_url override"
  exit 1
fi

if ! grep -q 'arg:model_providers.innies.wire_api="responses"' "$FAKE_CODEX_LOG"; then
  echo "smoke: missing codex wire_api override"
  exit 1
fi

if ! grep -q 'arg:model_providers.innies.requires_openai_auth=false' "$FAKE_CODEX_LOG"; then
  echo "smoke: missing codex auth override"
  exit 1
fi

if ! grep -q 'arg:model_providers.innies.supports_websockets=false' "$FAKE_CODEX_LOG"; then
  echo "smoke: missing codex websocket disable override"
  exit 1
fi

if ! grep -q 'arg:responses_websockets_v2=false' "$FAKE_CODEX_LOG"; then
  echo "smoke: missing codex responses websocket disable flag"
  exit 1
fi

if ! grep -q 'arg:model_providers.innies.env_http_headers."x-request-id"="INNIES_CORRELATION_ID"' "$FAKE_CODEX_LOG"; then
  echo "smoke: missing codex x-request-id header wiring"
  exit 1
fi

if ! grep -q 'arg:model_providers.innies.env_http_headers."x-innies-provider-pin"="INNIES_PROVIDER_PIN"' "$FAKE_CODEX_LOG"; then
  echo "smoke: missing codex pin header wiring"
  exit 1
fi

if ! grep -q 'arg:gpt-5.4' "$FAKE_CODEX_LOG"; then
  echo "smoke: missing codex default model injection"
  exit 1
fi

if ! grep -q 'arg:--help' "$FAKE_CODEX_LOG"; then
  echo "smoke: codex args not forwarded"
  exit 1
fi

if ! grep -q "INNIES_PROXY_URL:$MOCK_BASE_URL/v1/proxy/v1" "$FAKE_CODEX_LOG"; then
  echo "smoke: missing codex INNIES_PROXY_URL wiring"
  exit 1
fi

if ! grep -q "OPENAI_BASE_URL:$MOCK_BASE_URL/v1/proxy/v1" "$FAKE_CODEX_LOG"; then
  echo "smoke: missing codex OPENAI_BASE_URL wiring"
  exit 1
fi

if ! grep -q 'INNIES_PROVIDER_PIN:true' "$FAKE_CODEX_LOG"; then
  echo "smoke: missing codex provider pin env wiring"
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

if ! grep -q 'Innies hint: Token mode is not enabled for this org. Ask an operator to add the org to TOKEN_MODE_ENABLED_ORGS.' "$TMP_DIR/token_auth_failure.out"; then
  echo "smoke: token auth failure hint missing or unclear"
  exit 1
fi

if ! grep -q 'Innies hint: Token mode is not enabled for this org. Ask an operator to add the org to TOKEN_MODE_ENABLED_ORGS.' "$TMP_DIR/codex_token_auth_failure.out"; then
  echo "smoke: codex token auth failure hint missing or unclear"
  exit 1
fi

if [[ "${INNIES_SMOKE_REAL_PROXY:-0}" == "1" ]]; then
  if [[ -z "${INNIES_SMOKE_API_URL:-}" || -z "${INNIES_SMOKE_API_KEY:-}" || -z "${INNIES_SMOKE_IDEMPOTENCY_KEY:-}" ]]; then
    echo "smoke: INNIES_SMOKE_REAL_PROXY=1 requires INNIES_SMOKE_API_URL, INNIES_SMOKE_API_KEY, INNIES_SMOKE_IDEMPOTENCY_KEY"
    exit 1
  fi

  REAL_HEADERS="$TMP_DIR/real_proxy_headers.txt"
  REAL_BODY="$TMP_DIR/real_proxy_body.json"
  REAL_STATUS=$(curl -sS -D "$REAL_HEADERS" -o "$REAL_BODY" -w "%{http_code}" \
    -X POST "${INNIES_SMOKE_API_URL%/}/v1/proxy/v1/messages" \
    -H "Authorization: Bearer $INNIES_SMOKE_API_KEY" \
    -H "Idempotency-Key: $INNIES_SMOKE_IDEMPOTENCY_KEY" \
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
