# OpenClaw Integration Notes (Headroom)

## Summary
OpenClaw supports the exact integration pattern Headroom needs for MVP:
- custom base URL
- custom API key/token
- protocol compatibility mode (`openai` or `anthropic`)

This means Headroom can be used as a custom provider without building an OpenClaw-specific plugin first.

---

## Key Findings

### 1. CLI onboarding supports custom provider settings
OpenClaw CLI onboarding supports:
- `--custom-base-url`
- `--custom-model-id`
- `--custom-api-key`
- `--custom-compatibility <openai|anthropic>`

Source:
- https://docs.openclaw.ai/start/wizard-cli-reference

### 2. Config-level custom providers are supported
OpenClaw config supports provider entries with:
- `baseUrl`
- `apiKey`
- compatibility protocol (`openai-*` or `anthropic-messages`)
- custom headers/auth behavior

Source:
- https://docs.openclaw.ai/gateway/configuration-reference

### 3. Gateway API supports Bearer auth + streaming
OpenClaw Gateway docs indicate:
- `Authorization: Bearer <token>`
- `POST /v1/responses`
- SSE/streaming support

Source:
- https://docs.openclaw.ai/gateway/openresponses-http-api

---

## Recommendation for Headroom MVP
Use OpenClaw custom provider mode as the default integration path.

### Preferred setup model
- Headroom exposes one gateway endpoint (OpenAI-compatible or Anthropic-compatible).
- User provides `hr_...` token as API key.
- Compatibility mode selected based on gateway protocol.

### Example onboarding command
```bash
openclaw onboard \
  --auth-choice custom-api-key \
  --custom-base-url https://gateway.headroom.ai/v1 \
  --custom-model-id headroom/default \
  --custom-api-key hr_live_xxx \
  --custom-compatibility anthropic
```

If Headroom gateway is OpenAI-compatible, switch to:
- `--custom-compatibility openai`

---

## Product UX Implication
OpenClaw users can onboard to Headroom with a copy-paste command and continue normal workflow with minimal friction.

No OpenClaw-specific plugin is required for C1.
