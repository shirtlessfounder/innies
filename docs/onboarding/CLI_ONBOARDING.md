# Innies CLI Onboarding

## Purpose
Internal quickstart for the provider-specific Innies CLI wrappers:
- `innies claude`
- `innies codex`

This is the intended Phase 1 user-facing flow for internal users. The goal is simple: log in once with an Innies buyer key, then start either Claude or Codex through Innies without managing provider auth directly.

Current branch note:
- `innies claude` is already functional
- `innies codex` may still show a scaffold message until the Codex runtime lane is fully merged

## What These Commands Are
- `innies claude` starts a Claude session pinned to the Anthropic lane.
- `innies codex` starts a Codex session pinned to the Codex/OpenAI lane.
- both use the same Innies login/config
- both are normal wrapper commands, not a separate chat product

## Before You Start
Make sure you have:
- an Innies buyer key: `in_live_...`
- the upstream CLI you want to use already installed:
  - `claude` for `innies claude`
  - `codex` for `innies codex`

## Quickstart

### 1) Log in once
```bash
innies login --token in_live_REPLACE_ME
```

This writes local config to `~/.innies/config.json`.

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
Innies connected | model <model-id> | proxy <base-url>/v1/proxy | request <request-id>
```

After that:
- your args pass straight through to the upstream CLI
- the session keeps the upstream CLI's normal TTY behavior
- the wrapper exits with the same exit code as the upstream CLI

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

## Common Failure Cases
- `Missing --token`
  - rerun `innies login --token in_live_...`
- `Token must start with in_`
  - use an Innies buyer key, not an upstream provider token
- missing `claude` or `codex` binary
  - install the upstream CLI first, then rerun `innies doctor`
- wrapper recursion
  - point the wrapper at the real upstream binary, not another Innies shim

## Daily Flow
```bash
innies doctor
innies claude -- "<task>"
innies codex -- "<task>"
```

That is the intended Phase 1 UX.
