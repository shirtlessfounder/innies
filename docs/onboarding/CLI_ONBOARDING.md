# Innies CLI Onboarding

## What It Does
- `innies claude` — starts Claude Code routed through Innies (Anthropic lane)
- `innies codex` — starts Codex CLI routed through Innies (OpenAI lane)
- One login, two wrappers, deterministic provider routing

## Prerequisites
- Innies buyer key: `in_live_...`
- Upstream CLIs installed: `claude` and/or `codex`

## Quickstart

```bash
npm install -g innies
innies login --token in_live_REPLACE_ME
innies doctor          # verify setup
innies claude          # start Claude
innies codex           # start Codex
```

On connect, the wrapper prints:
```
Innies connected | model <model> | proxy <url> | request <id>
```
Then hands off to the upstream CLI with full TTY.

## Model Injection
Both wrappers inject a default `--model` unless you pass one explicitly:
- Claude: `claude-opus-4-6`
- Codex: `gpt-5.4`

## Codex Config Requirement
Codex ignores `OPENAI_BASE_URL`. Add this to `~/.codex/config.toml`:

```toml
model_provider = "innies"
responses_websockets_v2 = false

[model_providers.innies]
name = "innies"
base_url = "https://api.innies.computer/v1/proxy/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false
```

Websockets must be disabled — they bypass the proxy.

## Optional: Link Claude
```bash
innies link claude    # shims ~/.local/bin/claude
```
Refuses to overwrite a real Claude install. Use `innies claude` directly if linking fails.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Missing --token` | `innies login --token in_live_...` |
| `Token must start with in_` | Use Innies buyer key, not provider token |
| Missing `claude`/`codex` binary | Install upstream CLI, rerun `innies doctor` |
| `No active compatibility rule` | Model not in DB — add to `in_model_compatibility_rules` |
| Codex "high demand" / reconnecting | Check `~/.codex/config.toml` has innies provider + websockets off |
| Claude has active claude.ai login | Supported — `innies claude` uses a local bridge that injects buyer auth before forwarding to Innies |
| `Stream disconnected` | Check server logs for `synthetic_output_item_count: 0` |

## Daily Flow
```bash
innies doctor
innies claude -- "<task>"
innies codex -- "<task>"
```
