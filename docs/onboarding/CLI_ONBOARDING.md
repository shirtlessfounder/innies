# Innies CLI Onboarding

## Purpose
Internal quickstart for the provider-specific Innies CLI wrappers:
- `innies claude`
- `innies codex`

This is the intended Phase 1 user-facing flow for internal users. The goal is simple: log in once with an Innies buyer key, then start either Claude or Codex through Innies without managing provider auth directly.

Current branch note:
- `innies claude` and `innies codex` are both functional wrapper entrypoints
- both use the same Innies login/config and remain provider-pinned lanes

## What These Commands Are
- `innies claude` starts a Claude session pinned to the Anthropic lane.
- `innies codex` starts a Codex session pinned to the Codex/OpenAI lane.
- both use the same Innies login/config
- both are normal wrapper commands, not a separate chat product

## Before You Start
Make sure you have:
- an Innies buyer key: `in_live_...`
- the upstream CLI you want to use already installed:
  - `claude` (Claude Code) for `innies claude`
  - `codex` (Codex CLI) for `innies codex`

### Codex Config Requirement
Codex CLI needs a custom provider in `~/.codex/config.toml` to route through Innies. The wrapper injects `--config` flags, but if you have an existing config, add this to ensure routing works:

```toml
model_provider = "innies"

[model_providers.innies]
name = "innies"
base_url = "https://api.innies.computer/v1/proxy/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false
```

Also set `responses_websockets_v2 = false` in your `[general]` section — websockets bypass the proxy.

## Quickstart

### 1) Log in once
```bash
innies login --token in_live_REPLACE_ME
```

This writes local config to `~/.innies/config.json` with one shared Innies token, one fallback model, and provider defaults for the Claude and Codex lanes.

### 2) Check readiness
```bash
innies doctor
```

Expected:
- config is readable
- token is present
- installed CLI binaries are detected
- output makes it obvious which lane is broken if something is missing

### 3) Start Claude through Innies
```bash
innies claude -- --help
```

### 4) Start Codex through Innies
```bash
innies codex -- --help
```

## What The UX Looks Like
When a session starts, the wrapper prints one short status line before handing off to the upstream CLI.

Example shape:
```text
Innies connected | model <model-id> | proxy <proxy-url> | request <request-id>
```

In practice:
- `innies claude` uses the base URL (e.g. `https://api.innies.computer`) — Claude Code appends `/v1/messages` to hit the compat endpoint
- `innies codex` reports a Codex/OpenAI-lane proxy URL ending in `/v1/proxy/v1` — Codex appends `/responses`

After that:
- your args pass straight through to the upstream CLI
- the session keeps the upstream CLI's normal TTY behavior
- the wrapper exits with the same exit code as the upstream CLI
- Codex injects a custom `innies` provider config (not the built-in `openai` provider) so requests route through the proxy, and carries Innies correlation/pin headers
- The Claude wrapper injects `--model` (default: `claude-opus-4-6`) unless you pass `--model` yourself
- The Codex wrapper injects `--model` (default: `gpt-5.4`) unless you pass `--model` yourself

## Mental Model
- one Innies login
- two wrapper entrypoints
- deterministic provider routing per wrapper
- no need to manage Claude/Codex auth inside the wrapper flow

Use:
- `innies claude` when you want the Anthropic lane
- `innies codex` when you want the Codex/OpenAI lane

## Optional Convenience
If you want normal `claude` invocations to route through Innies:

```bash
innies link claude
```

This creates a shim in `~/.local/bin/claude`. Make sure `~/.local/bin` is ahead of other Claude install paths in `PATH`.

Safety note:
- if `~/.local/bin/claude` already points to a real Claude install, `innies link claude` now refuses to overwrite it
- in that case, use `innies claude` directly or move the existing Claude binary before linking

## Common Failure Cases
- `Missing --token`
  - rerun `innies login --token in_live_...`
- `Token must start with in_`
  - use an Innies buyer key, not an upstream provider token
- missing `claude` or `codex` binary
  - install the upstream CLI first, then rerun `innies doctor`
- wrapper recursion
  - point the wrapper at the real upstream binary, not another Innies shim
- token-mode not enabled / capacity / unauthorized hints
  - use the printed request id plus server-side routing evidence to debug the provider-pinned lane
- `No active compatibility rule for provider/model`
  - the model sent by the CLI isn't in the `in_model_compatibility_rules` DB table — add it or ensure `--model` is injected correctly
- `Stream disconnected before completion`
  - check server logs for `synthetic_output_item_count: 0` — upstream may be returning empty output
- Claude Code auth conflict warning (`Both a token and an API key are set`)
  - cosmetic — Innies sets `ANTHROPIC_API_KEY` (buyer token) alongside any existing claude.ai login; routing still works correctly via `ANTHROPIC_BASE_URL`
- Codex showing "high demand" / reconnecting
  - requests aren't reaching Innies — verify `~/.codex/config.toml` has the `[model_providers.innies]` section with correct `base_url` and `responses_websockets_v2 = false`

## Daily Flow
```bash
innies doctor
innies claude -- "<task>"
innies codex -- "<task>"
```

That is the intended Phase 1 UX.
