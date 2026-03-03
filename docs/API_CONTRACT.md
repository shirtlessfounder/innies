# Innies API Contract (C1)

## Version
`v1` (Checkpoint 1 internal)

## Auth
- All endpoints require API key auth via either:
  - `Authorization: Bearer <token>`
  - `x-api-key: <token>`
- `buyer_proxy` scope: proxy + usage endpoints.
- `admin` scope: admin + seller-key endpoints.

## Idempotency
- Required header for mutation endpoints:
  - `POST /v1/proxy/*`
  - `POST /v1/seller-keys`
  - `PATCH /v1/seller-keys/:id`
- `POST /v1/admin/kill-switch`
- `POST /v1/admin/replay-metering`
- `POST /v1/admin/token-credentials`
- `POST /v1/admin/token-credentials/rotate`
- `POST /v1/admin/token-credentials/:id/revoke`
- Header: `Idempotency-Key`
- Format: UUIDv7 or opaque token length >= 32.
- C1 proxy policy: proxy requests are metadata-only idempotent; duplicate proxy calls return deterministic `409` (`proxy_replay_not_supported`).
- Compat endpoint (`POST /v1/messages`): `Idempotency-Key` is optional.
- C1 compat policy (`POST /v1/messages`):
  - If `Idempotency-Key` is provided, duplicate replay returns deterministic `409` (`proxy_replay_not_supported`).
  - If header is missing, request proceeds with no idempotency persistence/replay contract.

## Correlation
- Clients should send `x-request-id`.
- If missing, API generates one and returns it in response header.

## Endpoints

### `POST /v1/proxy/*`
Proxy entrypoint for routed model requests.

Request body:
```json
{
  "provider": "anthropic",
  "model": "claude-code",
  "streaming": true,
  "payload": {}
}
```

Notes:
- `orgId` is derived from authenticated API key; request body org fields are ignored.
- Token mode is org-gated by `TOKEN_MODE_ENABLED_ORGS` allowlist.
- Token mode supports both non-streaming and streaming execution.
- Non-streaming responses mirror upstream HTTP status/body.
- Streaming responses are pass-through when upstream returns `text/event-stream`.
- Replay idempotency policy for proxy paths: deterministic non-replayable (`409` with `proxy_replay_not_supported` payload).

### `POST /v1/messages`
Anthropic-compatible passthrough endpoint (feature-flagged by `ANTHROPIC_COMPAT_ENDPOINT_ENABLED=true`).

Request body:
- Anthropic-native message payload (no wrapper), e.g.:
```json
{
  "model": "claude-opus-4-6",
  "max_tokens": 32,
  "messages": [{"role":"user","content":"hi"}],
  "stream": false
}
```

Notes:
- Auth/scoping matches proxy routes (buyer/admin API key required).
- `provider` is fixed to `anthropic`; internal mapping reuses proxy execution path.
- If `anthropic-version` is missing, default is `2023-06-01`.
- If `x-request-id` is missing, API generates and returns one.
- `stream=true` is supported; streaming passthrough is used when upstream returns `text/event-stream`.
- When `ANTHROPIC_COMPAT_ENDPOINT_ENABLED=false`, endpoint returns deterministic `404`.
- Thinking compatibility guardrails:
  - If `thinking.type = "enabled"` and `thinking.budget_tokens` is missing, API normalizes to `1024`.
  - If `thinking.type = "enabled"` and `thinking.budget_tokens` is provided, it must be a positive integer.
  - If `thinking.type = "enabled"` and `thinking.budget_tokens < 1024`, API returns deterministic `400` (`invalid_request`).
  - If `thinking.type = "enabled"` and `max_tokens`/`max_output_tokens` is `<= thinking.budget_tokens`, API returns deterministic `400` (`invalid_request`) with a clear validation message.
- Optional operational debug tracing:
  - `INNIES_COMPAT_TRACE=true` enables redacted request/response logs for `/v1/messages` only.
  - Keep disabled in normal production operation due to log volume.

### `POST /v1/seller-keys`
Create seller key (admin only).

### `PATCH /v1/seller-keys/:id`
Update seller key status/cap/weight (admin only).

### `POST /v1/admin/kill-switch`
Set kill switch state for `seller_key|org|model|global` (admin only).
For `scope=global`, `targetId` must be `*`.

### `POST /v1/admin/replay-metering`
Replay metering writes (usage/correction/reversal) for recovery operations (admin only).

### `POST /v1/admin/token-credentials`
Create token credential for an org/provider (admin only).
Contract: appends an additional credential for the same `(org, provider)` token pool.

### `POST /v1/admin/token-credentials/rotate`
Rotate token credential for an org/provider (admin only).
Contract: primary path for replacing existing credential material.

### `POST /v1/admin/token-credentials/:id/revoke`
Revoke a token credential by id (admin only).

### `GET /v1/usage/me`
Return usage summary for authenticated org.

### `GET /v1/admin/pool-health`
Returns key status totals.

## Error Codes (C1)
- `invalid_request` (400; 409 for deterministic contract conflicts such as token-credential write conflicts)
- `unauthorized` (401)
- `forbidden` (403)
- `capacity_unavailable` (429)
- `suspended` (423)
- `idempotency_mismatch` (409)
- `idempotency_replay_unavailable` (409)
- `proxy_replay_not_supported` (409)
- `upstream_non_retryable` (502)
- `upstream_error` (502)
- `internal_error` (500)

## Routing Policy (C1)
- Key selection: weighted round-robin over eligible active keys.
- Token mode credential selection: request-distributed across eligible active credentials (org + provider scoped).
- Retry/failover:
  - 429 rate limit -> backoff + failover
  - 5xx/network -> failover
  - auth/permission/model-invalid -> failover only when key-specific
- Token-mode retry/failover matrix:
  - 401/403 -> refresh once; if still failing, failover; if none, hard-fail
  - 429 -> backoff + failover
  - 5xx/network timeout -> failover
  - model/request-invalid -> hard-fail (no failover loop)
- Token-mode policy guard:
  - when `TOKEN_MODE_ENABLED_ORGS` is configured, non-allowlisted orgs are blocked deterministically (no legacy fallback)
- Routing telemetry writes include failed attempts with error metadata.
- Safety checks before routing:
  - global/org/model kill switches
  - active provider/model compatibility rule
