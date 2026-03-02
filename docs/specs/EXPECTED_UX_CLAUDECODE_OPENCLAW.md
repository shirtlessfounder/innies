# Expected UX: Claude Code + OpenClaw via Headroom

## Goal
Define the expected end-user experience for using Headroom in:
- Claude Code (CLI)
- OpenClaw

This is the target UX for Checkpoint 1 (internal team), designed to stay stable into Checkpoint 2.

---

## 1) Claude Code UX (CLI through Headroom)

### First-time setup
1. User signs into Headroom dashboard.
2. User creates personal/org access token (`hr_live_xxx`).
3. User runs setup:
```bash
curl -fsSL https://headroom.ai/install | bash
headroom login --token hr_live_xxx
headroom doctor
```
4. Optional convenience link:
```bash
headroom link claude
```
This makes normal `claude` usage route through Headroom (or user can run `headroom claude`).

### Daily use
- User runs:
```bash
claude
# or
headroom claude
```
- User sees lightweight connection status (example):
`Headroom connected | pool healthy | org cap 38%`

### Error/limit behavior
- Pool busy: auto retry/failover first, then short actionable message.
- Org cap reached: clear message with next step.
- Key quarantine: silent reroute when possible.

### Dashboard visibility (default)
- Show usage, latency, errors, cap consumption.
- Do not show raw prompt/response content by default.

---

## 2) OpenClaw UX (through Headroom custom provider)

### First-time setup (supported path)
OpenClaw supports custom provider onboarding with:
- custom base URL
- custom model ID
- custom API key
- compatibility mode (`openai` or `anthropic`)

Expected setup command:
```bash
openclaw onboard \
  --auth-choice custom-api-key \
  --custom-base-url https://gateway.headroom.ai/v1 \
  --custom-model-id headroom/default \
  --custom-api-key hr_live_xxx \
  --custom-compatibility anthropic
```
If Headroom gateway is OpenAI-compatible, use `--custom-compatibility openai`.

### Daily use
- User continues normal OpenClaw workflow.
- Requests are routed through Headroom pool.
- Streaming behavior is preserved.
- Optional UI indicator: `Routed via Headroom`.

### Error/limit behavior
- Same policy as Claude Code path:
  - failover on transient key/provider errors
  - clear user-facing cap/availability messages

---

## 3) Shared UX Principles
- One token per user/org (`hr_live_xxx`) for both flows.
- One-copy setup command from dashboard.
- `headroom doctor` as single troubleshooting command.
- Consistent error codes and guidance across clients.
- Minimal friction: users keep existing workflows after setup.

---

## 4) Operator Notes
- This UX assumes Headroom gateway auth/token model is operational.
- Routing and metering must be consistent across both integrations.
- Compatibility mode must match gateway protocol implementation.
