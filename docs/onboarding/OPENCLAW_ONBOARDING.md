# OpenClaw -> Innies Onboarding

## Purpose
Set up OpenClaw to use Innies as the Anthropic-compatible provider.

Intent note:
- OpenClaw is intended to be the model/provider-agnostic client in the Innies UX.
- Buyer-key provider preference exists primarily to steer OpenClaw and similar clients across providers.
- Future provider-specific wrappers such as `innies claude` and `innies codex` are separate pinned lanes and should not be treated as preference-routed clients.
- Current onboarding below uses the Anthropic-compatible path for bootstrap; that is an implementation detail of the current wiring, not the long-term OpenClaw routing intent.

If you still need a provider credential first, see:
- [Claude + Codex OAuth Token Quick Guide](./CLAUDE_CODEX_OAUTH_TOKENS.md)

## Quickstart (Required)

### 1) Configure OpenClaw to use Innies
Edit:
- `~/.openclaw/agents/main/agent/models.json`

Ensure provider config points to Innies and uses your assigned buyer key:

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

### 2) Add runtime UA patch and restart gateway

```bash
mkdir -p ~/.openclaw/patches ~/.config/systemd/user/openclaw-gateway.service.d

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

cat > ~/.config/systemd/user/openclaw-gateway.service.d/ua-patch.conf <<EOF2
[Service]
Environment=NODE_OPTIONS=--require=$HOME/.openclaw/patches/ua_patch.js
EOF2

systemctl --user daemon-reload
systemctl --user restart openclaw-gateway.service
```

### 3) Verify and test

Check patch loaded:
```bash
systemctl --user show openclaw-gateway.service --property=Environment --no-pager
```
Expected: contains `NODE_OPTIONS=--require=<home>/.openclaw/patches/ua_patch.js`

Send one short prompt from OpenClaw (example: `ping`), then check logs:
```bash
journalctl --user -u openclaw-gateway.service --since "3 min ago" --no-pager | grep -Ei "embedded run agent end|403|blocked|timed out|401|unauthorized"
```
Expected:
- no `403 Your request was blocked`
- no `LLM request timed out`

Optional direct probe:
```bash
curl -i -sS -X POST "https://api.innies.computer/v1/messages" \
  -H "x-api-key: in_live_REPLACE_ME" \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: fine-grained-tool-streaming-2025-05-14" \
  --data-binary '{"model":"claude-opus-4-6","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"ping"}]}'
```
Expected:
- `HTTP 200`
- `content-type: text/event-stream`

## Appendix (Optional)

### Reinstall/update OpenClaw
Reinstalling OpenClaw does not remove:
- `~/.openclaw/agents/...` config
- `~/.config/systemd/user/openclaw-gateway.service.d/ua-patch.conf`
- `~/.openclaw/patches/ua_patch.js`

After reinstall/update, re-run:
- `systemctl --user daemon-reload`
- `systemctl --user restart openclaw-gateway.service`
- step 3 verification.

### Rollback
```bash
rm -f ~/.config/systemd/user/openclaw-gateway.service.d/ua-patch.conf
systemctl --user daemon-reload
systemctl --user restart openclaw-gateway.service
```

Optional cleanup:
```bash
rm -f ~/.openclaw/patches/ua_patch.js
```

### Security notes
- Never paste buyer keys (`in_live_...`) or Anthropic tokens (`sk-ant-oat...`) into shared channels.
- Avoid `set -x` when handling secrets; it can leak keys into logs/history.
