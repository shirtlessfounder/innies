# OpenClaw → Innies Onboarding

Connect OpenClaw to Innies. Innies handles provider routing and model selection server-side — your OpenClaw config stays the same regardless of which provider (Anthropic, OpenAI) serves the request.

Need a provider credential first? See [Claude + Codex OAuth Token Guide](./CLAUDE_CODEX_OAUTH_TOKENS.md).

## Setup

### 1. Configure provider

Edit `~/.openclaw/agents/main/agent/models.json`:

```json
{
  "providers": {
    "innies": {
      "baseUrl": "https://api.innies.computer",
      "apiKey": "in_live_REPLACE_ME",
      "api": "anthropic-messages",
      "models": [
        {
          "id": "claude-opus-4-6",
          "api": "anthropic-messages"
        }
      ]
    }
  }
}
```

Replace `in_live_REPLACE_ME` with your buyer key.

### 2. Add UA patch

Cloudflare blocks OpenClaw's default user-agent. This patch overrides it for requests to Innies.

```bash
mkdir -p ~/.openclaw/patches

cat > ~/.openclaw/patches/ua_patch.js <<'JS'
const orig = global.fetch;
global.fetch = async (url, init = {}) => {
  const u = String(url || '');
  if (u.includes('api.innies.computer/v1/messages')) {
    const h = new Headers(init.headers || {});
    h.set('user-agent', 'OpenClawGateway/1.0');
    init = { ...init, headers: h };
  }
  return orig(url, init);
};
JS
```

Then load it via systemd override:

```bash
mkdir -p ~/.config/systemd/user/openclaw-gateway.service.d

cat > ~/.config/systemd/user/openclaw-gateway.service.d/ua-patch.conf <<EOF
[Service]
Environment=NODE_OPTIONS=--require=$HOME/.openclaw/patches/ua_patch.js
EOF

systemctl --user daemon-reload
```

### 3. Restart gateway

```bash
openclaw gateway restart
```

### 4. Verify

Send a test prompt from OpenClaw (e.g. `ping`), then check logs:

```bash
journalctl --user -u openclaw-gateway.service --since "3 min ago" --no-pager \
  | grep -Ei "403|401|unauthorized|timed out"
```

No output = working. Optional direct probe:

```bash
curl -sS -X POST "https://api.innies.computer/v1/messages" \
  -H "x-api-key: in_live_REPLACE_ME" \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-6","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"ping"}]}'
```

Expected: streaming SSE response starting with `event: message_start`.

## Provider Routing

OpenClaw always sends requests in Anthropic Messages format. Innies routes them based on your buyer key's provider preference:

- **Anthropic preference** → request goes directly to an Anthropic credential (Claude).
- **OpenAI preference** → Innies translates the request to OpenAI Responses format, routes to an OpenAI credential (Codex/GPT), and translates the response back. The default translated model is `gpt-5.4`.

You don't need separate OpenClaw configs for different providers. Provider preference is set server-side by an admin on your buyer key. The OpenClaw config above works for both.

Important: keep OpenClaw unpinned. Do not send `x-innies-provider-pin: true` and do not add `metadata.innies_provider_pin=true`.

- Unpinned OpenClaw traffic uses your buyer key's provider preference and automatic fallback to the other provider.
- Pinned Anthropic traffic stays on Anthropic only, even if the buyer key preference is set to OpenAI/Codex.
