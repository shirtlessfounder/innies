# OpenClaw → Innies Onboarding

Connect OpenClaw to Innies as its Anthropic-compatible provider.

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

### 2. Restart gateway

```bash
openclaw gateway restart
```

### 3. Verify

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

## Notes

- Reinstalling or updating OpenClaw preserves `~/.openclaw/agents/` config. Just restart the gateway after updates.
- Never paste buyer keys (`in_live_...`) or provider tokens (`sk-ant-oat...`) into shared channels.
