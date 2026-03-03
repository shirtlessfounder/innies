# Option 1 Scope: Anthropic-Native Passthrough Endpoint for OpenClaw

## Objective
Add a compatibility endpoint so OpenClaw can point to Innies as an Anthropic-compatible base URL without custom wrapper payloads.

Target UX:
- OpenClaw configured with base URL `https://api.innies.computer/v1`
- OpenClaw sends normal Anthropic request to `POST /v1/messages`
- Innies authenticates buyer token, routes through pooled token credentials, and returns Anthropic-native response

## Motivation (Why build this)

Current mismatch:
- Innies currently accepts wrapped proxy payloads at `POST /v1/proxy/v1/messages`:
  - `{ provider, model, streaming, payload }`
- OpenClaw Anthropic mode sends standard Anthropic payloads to `POST /v1/messages`
- Result: OpenClaw fails with `404 Cannot POST /v1/messages` and falls back/fails

Business impact:
- Blocks real-world adoption of Innies in existing OpenClaw deployments
- Forces custom integration or code changes in OpenClaw (bad distribution friction)
- Prevents validating core hypothesis in live traffic with minimal user behavior change

Feature intent:
- Make Innies drop-in compatible for Anthropic-style clients
- Preserve existing routing, metering, idempotency, kill-switch, and token-pool logic
- Avoid introducing a second routing system

## In Scope (MVP for this feature)

1. New compatibility endpoint
- `POST /v1/messages`
- Auth: same as existing (`Authorization: Bearer <buyer_token>` or `x-api-key`)
- Headers: preserve `anthropic-version`; forward compatible headers needed by token-mode behavior
- Body: Anthropic-native request shape (no wrapper)

2. Adapter layer (thin)
- Convert Anthropic-native inbound request into internal proxy execution input:
  - `provider = "anthropic"`
  - `model = body.model`
  - `streaming = body.stream ?? false`
  - `payload = raw request body`
- Reuse existing proxy/token-mode route logic (single source of truth)

3. Response contract
- Return upstream HTTP status + body untouched (JSON or text)
- Include existing Innies correlation headers where possible:
  - `x-request-id`
  - `x-innies-token-credential-id` / `x-innies-upstream-key-id`
  - `x-innies-attempt-no`

4. Idempotency behavior
- Keep current C1 metadata-only idempotency policy for existing proxy paths.
- For `POST /v1/messages` (compat path), `Idempotency-Key` is optional in C1.
- If header is provided, duplicate replay behavior matches proxy path:
  - deterministic `409` with `proxy_replay_not_supported`.
- If header is missing, C1 uses **no idempotency persistence** for compat route (no replay contract to client).

5. Non-streaming support required
- Must work for non-streaming Anthropic calls in C1
- C1 behavior for `stream=true`: deterministic reject (`400 model_invalid`) with explicit message.
- Streaming passthrough is C1.5 only.

## Out of Scope

- Full OpenAI-compatible API surface
- Anthropic endpoints beyond immediate need (`/v1/messages` only for now)
- Anthropic extras for C1:
  - `/v1/messages/count_tokens`
  - `/v1/models`
  - other Anthropic endpoint parity beyond `/v1/messages`
- Provider-agnostic passthrough for non-Anthropic providers
- Billing model redesign
- Client SDK wrappers

## Proposed API Contract

### `POST /v1/messages`

Request:
- Anthropic-native JSON body (example):
```json
{
  "model": "claude-opus-4-6",
  "max_tokens": 64,
  "messages": [{"role": "user", "content": "hi"}],
  "stream": false
}
```

Auth:
- buyer/admin key via existing middleware
- Accept both:
  - `Authorization: Bearer <token>`
  - `x-api-key: <token>`
- Org scoping remains derived from authenticated API key context.

Behavior:
- Internally mapped to existing Innies proxy execution
- Token-mode allowlist, kill-switches, compatibility rules still enforced
- Header behavior:
  - `anthropic-version` defaults to `2023-06-01` if missing.
  - `x-request-id` is generated if absent and returned in response header.

Response:
- Upstream native Anthropic response/status returned as-is

Errors:
- Reuse existing Innies structured errors for pre-routing failures:
  - `unauthorized`, `forbidden`, `capacity_unavailable`, `model_invalid`, `suspended`, etc.
- Upstream error payloads should pass through when request reaches provider

## Implementation Plan

1. Add thin compatibility adapter first (required MVP path)
- Implement `POST /v1/messages` with minimal glue to current proxy execution logic.
- Avoid broad refactor in C1 to minimize regression risk.
- Shared-executor extraction is optional follow-up only if trivially safe.

2. Add new route file (recommended)
- `api/src/routes/anthropicCompat.ts`
- Defines `POST /v1/messages`
- Validates minimal required fields (`model`, `messages`, `max_tokens` or Anthropic-accepted equivalent)
- Builds normalized internal proxy input and calls existing proxy execution path (shared executor only if already present)

3. Register route in server bootstrap
- Mount before 404 handler
- Ensure no collision with existing `/v1/proxy/*`

4. Header handling
- Preserve inbound `anthropic-version`
- Propagate/emit `x-request-id`
- Keep existing Innies observability headers

5. Tests
- Add unit/integration route tests for:
  - 200 success with Anthropic-native body
  - deterministic 400 reject when `stream=true`
  - 4xx/5xx passthrough behavior
  - optional idempotency behavior when `Idempotency-Key` absent
  - auth failure handling

6. Docs update
- Update `docs/API_CONTRACT.md`
- Add OpenClaw config example using base `https://api.innies.computer/v1`

## Acceptance Criteria

Functional:
1. OpenClaw configured with custom base URL `https://api.innies.computer/v1` can successfully call Innies via Anthropic-native `POST /v1/messages`.
2. Non-streaming requests return HTTP 200 and Anthropic-native payload format.
3. `stream=true` requests return deterministic `400` (`model_invalid`) in C1.
4. Routing/metering rows are written in `in_routing_events` and `in_usage_ledger`.
5. Token credential IDs rotate across active pool over multiple requests.

Compatibility:
1. Existing `POST /v1/proxy/*` integrations continue to work unchanged.
2. Existing admin/token/seller APIs unaffected.
3. Upstream `4xx/5xx` status+body passthrough is preserved on compat path after request reaches provider.

Reliability:
1. Build passes (`npm run build`)
2. Tests pass (`npm test`)
3. New compatibility tests added and passing.
4. With `ANTHROPIC_COMPAT_ENDPOINT_ENABLED=false`, `POST /v1/messages` returns deterministic `404`.

## Risks and Mitigations

1. Duplicate logic drift between `/v1/proxy/*` and `/v1/messages`
- Mitigation: shared executor function, no duplicated routing core

2. Subtle Anthropic request-shape differences
- Mitigation: minimal schema validation; pass unknown fields through in `payload`

3. Idempotency contract confusion across endpoints
- Mitigation: explicitly document split policy:
  - `/v1/proxy/*`: required key + metadata-only replay policy
  - `/v1/messages`: optional key, no replay guarantee when header absent

4. Streaming complexity
- Mitigation: C1 deterministically rejects `stream=true`; streaming passthrough is C1.5

## Rollout Plan

1. Ship behind compatibility flag (required):
- `ANTHROPIC_COMPAT_ENDPOINT_ENABLED=true`
- When disabled: `POST /v1/messages` returns deterministic `404`.

2. Internal validation:
- Single OpenClaw instance on AWS
- One buyer token
- Confirm 200 + expected DB telemetry

3. Expand:
- Enable for all internal teammates

## Agent Audit Checklist

Ask other agents to verify:
1. No divergence from shared proxy execution logic
2. Response/status passthrough fidelity for Anthropic-native clients
3. Idempotency behavior matches documented split policy
4. No regressions in `/v1/proxy/*`
5. Auth + org scoping unchanged
6. Token-pool routing and metering preserved
7. Flag-off behavior is deterministic (`404` when compat endpoint disabled)

## Decision

Recommendation: **Build Option 1 now**.
- High leverage for adoption
- Low architectural risk if implemented as an adapter over existing execution path
- Unblocks immediate OpenClaw deployment without changing user behavior
