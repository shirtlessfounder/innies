# Innies API Contract (C1)

## Version
`v1` (Checkpoint 1 internal)

## Auth
- All endpoints require API key auth via either:
  - `Authorization: Bearer <token>`
  - `x-api-key: <token>`
- `buyer_proxy` scope: proxy + usage endpoints.
- `admin` scope: admin + seller-key endpoints.
- Credential model distinction:
  - buyer/admin API keys authenticate clients to Innies
  - upstream provider credentials stored and routed by Innies are OAuth/session tokens from Claude Code and Codex/OpenAI logins, not public provider API keys

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
- `PATCH /v1/admin/buyer-keys/:id/provider-preference`
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
- wrapped proxy ingress continues to accept the envelope above.
- provider-native ingress is also accepted on the standard upstream-shaped proxy paths:
  - `POST /v1/proxy/v1/messages`: Anthropic-native body; Innies infers `provider=anthropic`, `model=body.model`, `streaming=(body.stream === true)`.
  - `POST /v1/proxy/v1/responses`: OpenAI Responses-native body; Innies infers `provider=openai`, `model=body.model`, `streaming=(body.stream === true)`.
- for wrapped proxy ingress, `provider` is optional at schema level; if omitted, request parsing defaults it to `anthropic`.
- Token mode is org-gated by `TOKEN_MODE_ENABLED_ORGS` allowlist.
- Token mode supports both non-streaming and streaming execution.
- Non-streaming responses mirror upstream HTTP status/body.
- Streaming responses are pass-through when upstream returns `text/event-stream`.
- For native `POST /v1/proxy/v1/responses` streaming requests, if upstream returns a successful non-SSE JSON response, Innies synthesizes native OpenAI Responses SSE events before returning to the client.
- For Anthropic compat callers (`POST /v1/messages` routed to `openai`), the equivalent non-SSE streaming fallback remains Anthropic-shaped SSE.
- Replay idempotency policy for proxy paths: deterministic non-replayable (`409` with `proxy_replay_not_supported` payload).
- Current token-mode provider resolution:
  - buyer-key preference source is the authenticated key’s stored preference
  - buyer-key preference is the main cross-provider steering control for OpenClaw and other model-agnostic clients
  - `codex` normalizes to canonical `openai` at ingress
  - OpenAI/Codex OAuth credentials are sent to the ChatGPT Codex backend (`/backend-api/codex/responses`), not the public `api.openai.com/v1/responses` path
  - Codex OAuth requests force `store=false` on Responses payloads
  - Codex OAuth streaming Responses requests force upstream `stream=true`
  - `ChatGPT-Account-Id` is derived from the OAuth access token when present
  - `POST /v1/messages` (compat mode) stays Anthropic-shaped at the client boundary, but can route to either provider under buyer-key preference
  - compat requests routed to `openai` are translated to `/v1/responses` and translated back into Anthropic-shaped JSON/SSE before returning to the client
  - provider-specific wrapper/CLI sessions are intentionally pinned and do not use cross-provider preference routing
  - session/CLI pinning is controlled by `x-innies-provider-pin: true` or request metadata `innies_provider_pin=true`
- Current token-mode routing metadata (from `in_routing_events.route_decision`) includes:
  - `reason`
  - `request_source`
  - `provider_selection_reason`
  - `provider_preferred`
  - `provider_effective`
  - `provider_plan`
  - `provider_fallback_from`
  - `provider_fallback_reason`
  - `openclaw_run_id`
  - `openclaw_session_id`
- Current reason values:
  - `preferred_provider_selected`
  - `fallback_provider_selected`
  - `cli_provider_pinned`
- Analytics source classification prefers explicit `request_source` when present; legacy rows fall back to the older `provider_selection_reason` / `openclaw_run_id` heuristic.

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
- request ingress is Anthropic-shaped and initially marked `provider=anthropic`, but runtime provider selection still honors buyer-key preference and fallback policy.
- when buyer preference resolves to `openai`, Innies translates the request to OpenAI Responses format upstream and translates the result back into Anthropic-shaped JSON/SSE for the client.
- If `anthropic-version` is missing, default is `2023-06-01`.
- If `x-request-id` is missing, API generates and returns one.
- `stream=true` is supported; streaming passthrough is used when upstream returns `text/event-stream`.
- When `ANTHROPIC_COMPAT_ENDPOINT_ENABLED=false`, endpoint returns deterministic `404`.
- Thinking compatibility guardrails:
  - If `thinking.type = "enabled"` and `thinking.budget_tokens` is missing, API normalizes to `1024`.
  - If `thinking.type = "enabled"` and `thinking.budget_tokens` is provided, it must be a positive integer.
  - If `thinking.type = "enabled"` and `thinking.budget_tokens < 1024`, API normalizes it up to `1024`.
  - If `thinking.type = "enabled"` and `max_tokens`/`max_output_tokens` is `<= thinking.budget_tokens`, API returns deterministic `400` (`invalid_request`) with a clear validation message.
- Tool-choice compatibility guardrail:
  - If `tool_choice` is a string (`auto|none|any`), API normalizes it to object form (`{"type":"..."}`).
- Request-size guardrails (deterministic `400 invalid_request`):
  - `ANTHROPIC_COMPAT_MAX_MESSAGE_COUNT` (default `1000`): if `messages.length` exceeds limit, request is rejected.
  - `ANTHROPIC_COMPAT_MAX_REQUEST_BYTES` (default `5000000`): if request payload bytes exceed limit, request is rejected.
  - Byte check behavior:
    - prefers inbound `Content-Length` when present
    - falls back to serialized payload byte-size check when `Content-Length` is missing
- OAuth credential header behavior:
  - For Anthropic OAuth access tokens (`sk-ant-oat*`), upstream auth is always sent as `Authorization: Bearer <token>` even if stored credential `authScheme` is `x_api_key`.
- 403 policy-block fallback (compat mode):
  - On upstream `403` with `"Your request was blocked."`, API retries once with sanitized beta headers and with `thinking` removed from payload.
  - If retry succeeds, response is returned normally.
  - If retry is also blocked, API passes through upstream `403` (does not remap to `401`).
- OAuth auth-error fallback (compat mode):
  - On upstream `401` auth error indicating OAuth-incompatible request mode, API retries once on the same credential while preserving original payload shape (`stream`/`tools`/`tool_choice`), and merges required OAuth betas.
- Compat audit logging:
  - `/v1/messages` upstream 4xx/403 outcomes emit structured `[compat-audit]` log line with `requestId`, `credentialId`, `attemptNo`, `upstreamStatus`, and upstream error type/message (if available).
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
Credential material:
- `anthropic`: Claude Code OAuth bearer token (`sk-ant-oat...`)
- `openai`: Codex/OpenAI OAuth/session token material, not a public OpenAI API key
  - expected fields: access token, refresh token when available
  - runtime behavior: Innies derives ChatGPT account context from the access token and uses OpenAI OAuth refresh against `auth.openai.com/oauth/token`
Optional field:
- `debugLabel` (1-64 chars): human-readable label stored with credential and emitted in routing/debug telemetry.

### `POST /v1/admin/token-credentials/rotate`
Rotate token credential for an org/provider (admin only).
Contract: primary path for replacing existing credential material.
Credential material:
- `anthropic`: Claude Code OAuth bearer token (`sk-ant-oat...`)
- `openai`: Codex/OpenAI OAuth/session token material, not a public OpenAI API key
  - expected fields: access token, refresh token when available
  - runtime behavior: Innies derives ChatGPT account context from the access token and uses OpenAI OAuth refresh against `auth.openai.com/oauth/token`
Optional field:
- `debugLabel` (1-64 chars): human-readable label stored with credential and emitted in routing/debug telemetry.

### `POST /v1/admin/token-credentials/:id/revoke`
Revoke a token credential by id (admin only).

### `GET /v1/admin/buyer-keys/:id/provider-preference`
Read provider preference for a buyer API key (admin only).

Response shape:
- `preferredProvider`: nullable explicit preference (`anthropic|openai`)
- `effectiveProvider`: effective provider after applying default fallback
- `source`: `explicit|default`

Default behavior:
- if no explicit preference is set, effective provider defaults to `anthropic`
- override default via `BUYER_PROVIDER_PREFERENCE_DEFAULT` (`anthropic|openai|codex`, where `codex` maps to `openai`)
- intended primary consumer: OpenClaw and other model-agnostic clients that should route across providers via buyer-key preference rather than a provider-pinned entrypoint

### `PATCH /v1/admin/buyer-keys/:id/provider-preference`
Set/clear provider preference for a buyer API key (admin only).

Request body:
```json
{
  "preferredProvider": "openai"
}
```

Notes:
- `preferredProvider` accepts `anthropic|openai|codex|null`.
- `codex` is normalized to canonical `openai`.
- `null` clears explicit preference and falls back to default provider behavior.

### `GET /v1/usage/me`
Return usage summary for authenticated org.

### `GET /v1/admin/pool-health`
Returns key status totals.

### `GET /v1/admin/analytics/tokens`
Admin-only per-token usage breakdown.

Query params:
- `window`: `24h|7d|1m|all|30d` (`30d` normalizes to `1m`; default `24h`)
- `provider`: `anthropic|openai|codex` (`codex` normalizes to `openai`)
- `source`: `openclaw|cli-claude|cli-codex|direct`

Response example:
```json
{
  "window": "1m",
  "tokens": [
    {
      "credentialId": "11111111-1111-4111-8111-111111111111",
      "debugLabel": "dylan-anthropic-1",
      "provider": "anthropic",
      "status": "active",
      "requests": 412,
      "usageUnits": 89400,
      "retailEquivalentMinor": 15200,
      "inputTokens": 1240000,
      "outputTokens": 62000,
      "bySource": {
        "openclaw": { "requests": 300, "usageUnits": 65000 },
        "cli-claude": { "requests": 112, "usageUnits": 24400 },
        "cli-codex": { "requests": 0, "usageUnits": 0 },
        "direct": { "requests": 0, "usageUnits": 0 }
      }
    }
  ]
}
```

### `GET /v1/admin/analytics/tokens/health`
Admin-only token health snapshot plus rolling maxing/utilization metrics.

Query params:
- `window`: `24h|7d|1m|all|30d` (`30d` normalizes to `1m`; default `7d`)
- `provider`: `anthropic|openai|codex` (`codex` normalizes to `openai`)
- `source`: `openclaw|cli-claude|cli-codex|direct`

Notes:
- current credential state fields (`status`, `maxedAt`, `nextProbeAt`, etc.) are point-in-time values
- rolling fields (`requestsBeforeMaxedLastWindow`) use the requested `window`
- `requestsBeforeMaxedLastWindow` is currently descoped and returns `null` until paired maxed-event analysis lands
- Derived maxing metrics (`avgRequestsBeforeMaxed`, `avgUsageUnitsBeforeMaxed`, `avgRecoveryTimeMs`, `estimatedDailyCapacityUnits`, `maxingCyclesObserved`) are descoped and return `null` — they require paired event analysis not yet implemented
- `utilizationRate24h` is currently descoped and returns `null` until actual 24h usage can be compared against a real capacity estimate
- `source` is accepted for contract consistency; current health output is metadata plus descoped `null` derived fields, so credential metadata rows are always returned

Response example:
```json
{
  "window": "7d",
  "tokens": [
    {
      "credentialId": "11111111-1111-4111-8111-111111111111",
      "debugLabel": "dylan-anthropic-1",
      "provider": "anthropic",
      "status": "active",
      "consecutiveFailures": 0,
      "lastFailedStatus": null,
      "lastFailedAt": null,
      "maxedAt": null,
      "nextProbeAt": null,
      "lastProbeAt": null,
      "monthlyContributionLimitUnits": 500000,
      "monthlyContributionUsedUnits": 123000,
      "monthlyWindowStartAt": "2026-03-01T00:00:00.000Z",
      "maxedEvents7d": 0,
      "requestsBeforeMaxedLastWindow": null,
      "avgRequestsBeforeMaxed": null,
      "avgUsageUnitsBeforeMaxed": null,
      "avgRecoveryTimeMs": null,
      "estimatedDailyCapacityUnits": null,
      "maxingCyclesObserved": null,
      "utilizationRate24h": null,
      "createdAt": "2026-02-15T00:00:00.000Z",
      "expiresAt": "2026-06-01T00:00:00.000Z"
    }
  ]
}
```

### `GET /v1/admin/analytics/tokens/routing`
Admin-only routing/error/latency stats per token.

Query params:
- `window`: `24h|7d|1m|all|30d` (`30d` normalizes to `1m`; default `24h`)
- `provider`: `anthropic|openai|codex` (`codex` normalizes to `openai`)
- `source`: `openclaw|cli-claude|cli-codex|direct`

Response example:
```json
{
  "window": "24h",
  "tokens": [
    {
      "credentialId": "11111111-1111-4111-8111-111111111111",
      "debugLabel": "dylan-anthropic-1",
      "provider": "anthropic",
      "totalAttempts": 200,
      "successCount": 195,
      "errorCount": 5,
      "errorBreakdown": {
        "401": 2,
        "429": 3
      },
      "latencyP50Ms": 1200,
      "latencyP95Ms": 4800,
      "ttfbP50Ms": 280,
      "ttfbP95Ms": 650,
      "fallbackCount": 3,
      "authFailures24h": 2,
      "rateLimited24h": 3
    }
  ]
}
```

### `GET /v1/admin/analytics/system`
Admin-only pool-wide analytics summary.

Query params:
- `window`: `24h|7d|1m|all|30d` (`30d` normalizes to `1m`; default `24h`)
- `provider`: `anthropic|openai|codex` (`codex` normalizes to `openai`)
- `source`: `openclaw|cli-claude|cli-codex|direct`

Response example:
```json
{
  "window": "24h",
  "totalRequests": 1450,
  "totalUsageUnits": 320000,
  "byProvider": {
    "anthropic": { "requests": 1200, "usageUnits": 280000 },
    "openai": { "requests": 250, "usageUnits": 40000 }
  },
  "byModel": {
    "claude-opus-4-6": { "requests": 1200, "usageUnits": 280000 },
    "gpt-5.4": { "requests": 250, "usageUnits": 40000 }
  },
  "latencyP50Ms": 1400,
  "latencyP95Ms": 5200,
  "ttfbP50Ms": 310,
  "ttfbP95Ms": 710,
  "errorRate": 0.034,
  "fallbackRate": 0.02,
  "activeTokens": 8,
  "maxedTokens": 1,
  "totalTokens": 10,
  "maxedEvents7d": 4,
  "bySource": {
    "openclaw": { "requests": 900, "usageUnits": 200000 },
    "cli-claude": { "requests": 400, "usageUnits": 90000 },
    "cli-codex": { "requests": 100, "usageUnits": 20000 },
    "direct": { "requests": 50, "usageUnits": 10000 }
  },
  "translationOverhead": null,
  "topBuyers": [
    {
      "apiKeyId": "22222222-2222-4222-8222-222222222222",
      "orgId": "33333333-3333-4333-8333-333333333333",
      "requests": 800,
      "usageUnits": 180000,
      "percentOfTotal": 0.56
    }
  ]
}
```

Notes:
- `translationOverhead` is currently `null`; translated-request attribution is not yet wired end-to-end
- `topBuyers[*].percentOfTotal` is a `0..1` ratio, not a `0..100` percentage

### `GET /v1/admin/analytics/timeseries`
Admin-only chart-series endpoint.

Query params:
- `window`: `24h|7d|1m|all|30d` (`30d` normalizes to `1m`; default `1m`)
- `granularity`: `hour|day` (default `hour` for `24h`, else `day`)
- `provider`: `anthropic|openai|codex` (`codex` normalizes to `openai`)
- `source`: `openclaw|cli-claude|cli-codex|direct`
- `credentialId`: UUID filter

Response example:
```json
{
  "window": "1m",
  "granularity": "day",
  "series": [
    {
      "date": "2026-03-07",
      "requests": 145,
      "usageUnits": 32000,
      "errorRate": 0.02,
      "latencyP50Ms": 1300
    }
  ]
}
```

### `GET /v1/admin/analytics/requests`
Admin-only recent request drill-down. Response content is preview-only by default.

Query params:
- `window`: `24h|7d|1m|all|30d` (`30d` normalizes to `1m`; default `24h`)
- `limit`: `1..200` (default `50`)
- `provider`: `anthropic|openai|codex` (`codex` normalizes to `openai`)
- `source`: `openclaw|cli-claude|cli-codex|direct`
- `credentialId`: UUID filter
- `model`: exact model filter
- `minLatencyMs`: integer `>= 0`

Notes:
- `prompt` and `response` are preview fields sourced from request-log storage
- full prompt/response content is off by default and not part of the baseline contract
- `REQUEST_LOG_STORE_FULL` is not yet wired; ignore it for Phase 1 contract purposes

Response example:
```json
{
  "window": "24h",
  "limit": 50,
  "requests": [
    {
      "requestId": "req_123",
      "createdAt": "2026-03-07T14:32:00.000Z",
      "credentialId": "11111111-1111-4111-8111-111111111111",
      "credentialLabel": "dylan-anthropic-1",
      "provider": "anthropic",
      "model": "claude-opus-4-6",
      "source": "openclaw",
      "translated": false,
      "streaming": true,
      "upstreamStatus": 200,
      "latencyMs": 1450,
      "ttfbMs": 320,
      "inputTokens": 12400,
      "outputTokens": 680,
      "usageUnits": 1340,
      "prompt": "[first 500 chars]",
      "response": "[first 500 chars]"
    }
  ]
}
```

### `GET /v1/admin/analytics/anomalies`
Admin-only analytics confidence and data-quality checks.

Query params:
- `window`: `24h|7d|1m|all|30d` (`30d` normalizes to `1m`; default `24h`)
- `provider`: `anthropic|openai|codex` (`codex` normalizes to `openai`)
- `source`: `openclaw|cli-claude|cli-codex|direct`

Response example:
```json
{
  "window": "24h",
  "checks": {
    "missingDebugLabels": 0,
    "unresolvedCredentialIdsInTokenModeUsage": 0,
    "nullCredentialIdsInRouting": 0,
    "staleAggregateWindows": null,
    "usageLedgerVsAggregateMismatchCount": null
  },
  "ok": true
}
```

Notes:
- `staleAggregateWindows` and `usageLedgerVsAggregateMismatchCount` are descoped and return `null` until implemented

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
- Token credential maxing/quarantine:
  - Credentials can be auto-marked `maxed` after repeated upstream auth-like failures.
  - Default maxing statuses are `401` only (`TOKEN_CREDENTIAL_MAX_ON_STATUSES=401`).
  - Default threshold is `10` consecutive matching failures (`TOKEN_CREDENTIAL_MAXED_CONSECUTIVE_FAILURES=10`).
  - Auto-maxed credentials are removed from active routing pool until probe reactivation.
  - Successful routed request on an active/rotating credential resets consecutive failure count.
- Token credential probe/reactivation:
  - Background job: `token-credential-healthcheck-hourly`.
  - Enabled by default (`TOKEN_CREDENTIAL_PROBE_ENABLED=true`).
  - Schedule default: hourly (`TOKEN_CREDENTIAL_PROBE_SCHEDULE_MS=3600000`).
  - Probe timeout default: `10000ms` (`TOKEN_CREDENTIAL_PROBE_TIMEOUT_MS=10000`).
  - Probe batch default: `20` creds (`TOKEN_CREDENTIAL_PROBE_MAX_KEYS=20`).
  - Next probe interval default: 24h (`TOKEN_CREDENTIAL_PROBE_INTERVAL_HOURS=24`).
  - Probe model default: `claude-opus-4-6` (`TOKEN_CREDENTIAL_PROBE_MODEL` override).
- Token-mode policy guard:
  - when `TOKEN_MODE_ENABLED_ORGS` is configured, non-allowlisted orgs are blocked deterministically (no legacy fallback)
- Routing telemetry writes include failed attempts with error metadata.
- Safety checks before routing:
  - global/org/model kill switches
  - active provider/model compatibility rule
