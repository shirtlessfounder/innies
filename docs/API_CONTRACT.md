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
- `PATCH /v1/admin/token-credentials/:id/contribution-cap`
- `POST /v1/admin/token-credentials/:id/probe`
- `POST /v1/admin/token-credentials/:id/provider-usage-refresh`
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
- Synthetic OpenAI Responses fallback preserves terminal status semantics (`response.completed|response.incomplete|response.failed`) and avoids zero-output-item streams for response-like JSON payloads.
- If a proxied SSE stream ends before a terminal event, Innies emits a terminal failure SSE instead of leaving the client with a raw truncated stream.
- For Anthropic compat callers (`POST /v1/messages` routed to `openai`), the equivalent non-SSE streaming fallback remains Anthropic-shaped SSE.
- Replay idempotency policy for proxy paths: deterministic non-replayable (`409` with `proxy_replay_not_supported` payload).
- Current token-mode provider resolution:
  - buyer-key preference source is the authenticated key’s stored preference
  - buyer-key preference is the main cross-provider steering control for OpenClaw and other model-agnostic clients
  - non-pinned buyer traffic always builds a two-provider plan: `[effective preferred provider, alternate provider]`
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
  - If `thinking.type = "adaptive"`, API preserves it and does not inject `budget_tokens`.
  - For extended thinking requests (`thinking.type = "enabled" | "adaptive"`), API returns deterministic `400` when `tool_choice.type` is `any` or `tool`; only `auto` and `none` are allowed.
  - For extended thinking requests (`thinking.type = "enabled" | "adaptive"`), API returns deterministic `400` when the final message role is `assistant` (assistant prefill).
  - For extended thinking requests (`thinking.type = "enabled" | "adaptive"`), API returns deterministic `400` when preserved assistant `thinking` blocks in tool-use history omit `signature`.
- Anthropic message-history guardrails (deterministic `400 invalid_request`):
  - `tool_result` blocks must come first in each user message content array.
  - A user message containing `tool_result` blocks must immediately follow the prior assistant `tool_use` message and match its `tool_use` ids.
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
  - Anthropic OAuth `/v1/messages` upstream requests also send Claude-style identity headers: `anthropic-dangerous-direct-browser-access: true`, `x-app`, and `user-agent`.
  - When strict Anthropic passthrough preserves an inbound `anthropic-beta` lane, Innies still merges the configured Anthropic OAuth beta set upstream.
- 403 policy-block fallback (compat mode):
  - On upstream `403` with `"Your request was blocked."`, API retries once with sanitized beta headers and with `thinking` removed from payload.
  - If retry succeeds, response is returned normally.
  - If retry is also blocked, API passes through upstream `403` (does not remap to `401`).
- OAuth auth-error fallback (compat mode):
  - On upstream `401` auth error indicating OAuth-incompatible request mode, API retries once on the same credential while preserving original payload shape (`stream`/`tools`/`tool_choice`), and merges required OAuth betas.
- Compat audit logging:
  - `/v1/messages` upstream 4xx/403 outcomes emit structured `[compat-audit]` log line with `requestId`, `credentialId`, `attemptNo`, `upstreamStatus`, and upstream error type/message (if available).
  - Anthropic upstream `400 invalid_request_error` passthroughs also emit `[compat-invalid-request-debug]` with a deep redacted request-shape trace: full message topology, block ordering, `tool_use`/`tool_result` ids, thinking-signature presence, and analyzer-detected history anomalies; no raw prompt or tool payload text is logged.
  - Deterministic local Anthropic compat validation failures also emit `[compat-local-validation-failed]` with the same redacted request-shape trace before returning a local `400`.
- Optional operational debug tracing:
  - `INNIES_COMPAT_TRACE=true` enables redacted request/response logs for `/v1/messages` only.
  - `INNIES_ENABLE_UPSTREAM_DEBUG_HEADERS=true` allows opt-in first-pass upstream lane headers on compat responses when the caller sends `x-innies-debug-upstream-lane: 1`.
  - exposed debug headers are redacted and include target URL, forwarded request-id, token kind, header names, plus key Anthropic header values (`accept`, `anthropic-version`, `anthropic-beta`, optional `user-agent`).
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
  - expected fields: access token, refresh token when available
  - runtime behavior: when a refresh token is stored, Innies can best-effort refresh Claude OAuth credentials against `platform.claude.com/v1/oauth/token`
- `openai`: Codex/OpenAI OAuth/session token material, not a public OpenAI API key
  - expected fields: access token, refresh token when available
  - runtime behavior: Innies derives ChatGPT account context from the access token and uses OpenAI OAuth refresh against `auth.openai.com/oauth/token`
Optional field:
- `debugLabel` (1-64 chars): human-readable label stored with credential and emitted in routing/debug telemetry.
- if `debugLabel` is omitted during rotate, Innies keeps the previous credential's label when rotating an existing credential

### `POST /v1/admin/token-credentials/rotate`
Rotate token credential for an org/provider (admin only).
Contract: primary path for replacing existing credential material.
Behavior:
- if `previousCredentialId` is omitted, Innies rotates the latest `active` credential for that `(org, provider)` lane when one exists
- if `previousCredentialId` is provided, it may target an `active` or `maxed` credential in that `(org, provider)` lane; Innies revokes that prior credential after inserting the replacement
Credential material:
- `anthropic`: Claude Code OAuth bearer token (`sk-ant-oat...`)
  - expected fields: access token, refresh token when available
  - runtime behavior: when a refresh token is stored, Innies can best-effort refresh Claude OAuth credentials against `platform.claude.com/v1/oauth/token`
- `openai`: Codex/OpenAI OAuth/session token material, not a public OpenAI API key
  - expected fields: access token, refresh token when available
  - runtime behavior: Innies derives ChatGPT account context from the access token and uses OpenAI OAuth refresh against `auth.openai.com/oauth/token`
Optional field:
- `debugLabel` (1-64 chars): human-readable label stored with credential and emitted in routing/debug telemetry.

### `POST /v1/admin/token-credentials/:id/revoke`
Revoke a token credential by id (admin only).

### `POST /v1/admin/token-credentials/:id/pause`
Pause an `active` token credential so routing stops using it until an operator explicitly unpauses it (admin only).

Response shape:
- `ok`: always `true` on success
- `id`: token credential id
- `orgId`: owning org id
- `provider`: token provider
- `debugLabel`: credential label when present
- `status`: resulting Innies status (`paused`)
- `changed`: `true` when Innies flipped the credential to `paused`; `false` when it was already paused

Notes:
- only `active` credentials can be newly paused
- already-paused credentials return `200` with `changed: false`
- `maxed|expired|revoked|rotating` credentials are rejected with `invalid_request` / `409`
- request is idempotent and requires an `idempotency-key` header

### `POST /v1/admin/token-credentials/:id/unpause`
Unpause a `paused` token credential so routing may use it again (admin only).

Response shape:
- `ok`: always `true` on success
- `id`: token credential id
- `orgId`: owning org id
- `provider`: token provider
- `debugLabel`: credential label when present
- `status`: resulting Innies status (`active`)
- `changed`: `true` when Innies flipped the credential back to `active`; `false` when it was already active

Notes:
- only `paused`, unexpired credentials can be newly unpaused
- already-active credentials return `200` with `changed: false`
- `maxed|expired|revoked|rotating` credentials are rejected with `invalid_request` / `409`
- unpausing does not wipe any existing `rate_limited_until` backoff; it only restores `status = active`
- request is idempotent and requires an `idempotency-key` header

### `PATCH /v1/admin/token-credentials/:id/contribution-cap`
Set or clear Claude contribution-cap reserves for a token credential (admin only).

Request body:
```json
{
  "fiveHourReservePercent": 20,
  "sevenDayReservePercent": 10
}
```

Notes:
- each field is optional, but at least one of `fiveHourReservePercent` or `sevenDayReservePercent` must be present
- each reserve percent is an integer in `0..100`
- `0` means no protected reserve for that window
- only Claude token credentials accept this mutation; non-Claude credentials are rejected with `invalid_request` / `400`
- non-Claude analytics rows still keep the raw contribution-cap fields `null`
- request is idempotent and requires an `idempotency-key` header

Response shape:
- `ok`: always `true` on success
- `id`: token credential id
- `provider`: token provider
- `orgId`: owning org id
- `fiveHourReservePercent`: resulting stored 5h reserve percent
- `sevenDayReservePercent`: resulting stored 7d reserve percent

### `POST /v1/admin/token-credentials/:id/probe`
Probe an `active` or `maxed` token credential immediately (admin only).

Response shape:
- `probeOk`: whether the upstream probe succeeded
- `reactivated`: whether Innies flipped a previously `maxed` credential back to `active`
- `status`: resulting Innies status (`active|maxed`)
- `upstreamStatus`: HTTP status from upstream probe when available
- `reason`: probe result reason (`ok|status_<code>|network:<message>|unsupported_provider:<provider>`)
- `nextProbeAt`: next scheduled automatic probe time when a `maxed` manual probe failed; `null` for active-credential diagnostic probes
- `authDiagnosis`: optional operator-facing auth diagnosis when Innies can derive one (`access_token_expired_local`, `upstream_status_401`, etc.)
- `accessTokenExpiresAt`: optional derived local access-token expiry timestamp when available
- `refreshTokenState`: optional refresh-token state (`missing|present`) when Innies can determine it

Notes:
- intended operator use: immediately test whether a quarantined credential has recovered, or run a live diagnostic against an active credential, without waiting for the background healthcheck
- only `active` or `maxed`, unexpired credentials can be manually probed
- successful `maxed` probe reactivates the credential immediately so routing can use it again
- successful `active` probe is diagnostic-only and leaves the credential state unchanged
- failed `maxed` probe keeps the credential `maxed` and pushes `nextProbeAt` forward by the normal probe interval
- failed `active` probe is diagnostic-only and leaves the credential state unchanged
- auth-diagnosis fields are best-effort operator hints; they are omitted when Innies cannot derive anything more specific than the raw probe result

### `POST /v1/admin/token-credentials/:id/provider-usage-refresh`
Refresh Claude provider usage for a token immediately (admin only).

Response shape:
- `refreshOk`: whether the Anthropic usage refresh succeeded
- `status`: current Innies credential status
- `upstreamStatus`: upstream HTTP status when available
- `reason`: refresh result reason (`ok|status_<code>|network:<message>|invalid_payload:*|provider_usage_snapshot_write_failed`)
- `category`: refresh failure category (`fetch_failed|fetch_backoff|snapshot_write_failed`) or `null`
- `warningReason`: operator warning state synced from the refresh result when applicable
- `nextProbeAt`: next scheduled auth-recovery probe time when a usage refresh auth-failure parked the credential
- `retryAfterMs`: retry backoff duration when the refresh failed and surfaced one
- `reserve`: stored `fiveHourReservePercent` / `sevenDayReservePercent`
- `snapshot`: parsed snapshot summary when refresh succeeded:
  - `usageSource`
  - `fetchedAt`
  - `fiveHourUtilizationRatio`
  - `fiveHourUsedPercent`
  - `fiveHourResetsAt`
  - `fiveHourContributionCapExhausted`
  - `fiveHourProviderUsageExhausted`
  - `sevenDayUtilizationRatio`
  - `sevenDayUsedPercent`
  - `sevenDayResetsAt`
  - `sevenDayContributionCapExhausted`
  - `sevenDayProviderUsageExhausted`
- `lifecycle`: contribution-cap lifecycle transitions emitted during sync (`fiveHourTransition`, `sevenDayTransition`)
- `rawPayload`: raw Anthropic usage payload when one was returned
- `stateSyncErrors`: non-fatal warning/lifecycle sync errors encountered after refresh

Notes:
- intended operator use: compare Anthropic's raw quota payload with Innies' parsed 5h / 7d view for a specific Claude token
- supported for Anthropic OAuth credentials; expired access tokens can still be refreshed here when Innies has a stored OAuth refresh token
- route bypasses in-memory usage-fetch backoff so operators can debug a token immediately
- successful refresh persists the latest snapshot locally and attempts to sync warning + contribution-cap lifecycle state
- upstream `401` / `403` from the usage endpoint is treated as an auth failure: Innies parks the credential, schedules probe recovery, and stops treating the token like merely stale quota state

### `GET /v1/admin/buyer-keys/:id/provider-preference`
Read provider preference for a buyer API key (admin only).

Response shape:
- `preferredProvider`: nullable explicit preference (`anthropic|openai`)
- `effectiveProvider`: effective provider after applying default fallback
- `source`: `explicit|default`

Default behavior:
- if no explicit preference is set, effective provider defaults to `anthropic`
- override default via `BUYER_PROVIDER_PREFERENCE_DEFAULT` (`anthropic|openai|codex`, where `codex` maps to `openai`)
- non-pinned buyer routing still gets the alternate provider as fallback automatically; changing the preferred provider flips the fallback order as well
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
- `window`: `5h|24h|7d|1m|all|30d` (`30d` normalizes to `1m`; default `24h`)
- `provider`: `anthropic|openai|codex` (`codex` normalizes to `openai`)
- `source`: `openclaw|cli-claude|cli-codex|direct`

Notes:
- `attempts` is attempt-level volume for the selected window
- `requests` is distinct `request_id` count for the selected window
- `displayKey` is a safe display fallback, not a raw token secret

Response example:
```json
{
  "window": "1m",
  "tokens": [
    {
      "credentialId": "11111111-1111-4111-8111-111111111111",
      "displayKey": "cred_1111...1111",
      "debugLabel": "dylan-anthropic-1",
      "provider": "anthropic",
      "status": "active",
      "attempts": 430,
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
Admin-only token health snapshot plus rolling maxing/utilization metrics and nullable Claude contribution-cap fields.

Query params:
- `window`: `5h|24h|7d|1m|all|30d` (`30d` normalizes to `1m`; default `7d`)
- `provider`: `anthropic|openai|codex` (`codex` normalizes to `openai`)
- `source`: `openclaw|cli-claude|cli-codex|direct`

Notes:
- current credential state fields (`status`, `maxedAt`, `nextProbeAt`, etc.) are point-in-time values
- Claude contribution-cap/provider-usage fields are:
  - `fiveHourReservePercent`
  - `fiveHourUtilizationRatio`
  - `fiveHourResetsAt`
  - `fiveHourContributionCapExhausted`
  - `sevenDayReservePercent`
  - `sevenDayUtilizationRatio`
  - `sevenDayResetsAt`
  - `sevenDayContributionCapExhausted`
  - `providerUsageFetchedAt`
- Claude cap-cycle analytics fields are:
  - `claudeFiveHourCapExhaustionCyclesObserved`
  - `claudeFiveHourUsageUnitsBeforeCapExhaustionLastWindow`
  - `claudeFiveHourAvgUsageUnitsBeforeCapExhaustion`
  - `claudeSevenDayCapExhaustionCyclesObserved`
  - `claudeSevenDayUsageUnitsBeforeCapExhaustionLastWindow`
  - `claudeSevenDayAvgUsageUnitsBeforeCapExhaustion`
- those fields are Claude-only and stay `null` on non-Claude rows
- Claude rows may also keep them `null` when a fresh provider-usage snapshot has not been fetched yet or analytics is reading against a pre-migration environment
- analytics should treat rows with `expiresAt <= now` as `expired` for operator-facing status/counting even if the stored DB `status` has not been swept yet
- rows may also include best-effort auth-diagnosis fields for operator visibility:
  - `authDiagnosis`
  - `accessTokenExpiresAt`
  - `refreshTokenState`
- maxed-cycle metrics (`requestsBeforeMaxedLastWindow`, `avgRequestsBeforeMaxed`, `avgUsageUnitsBeforeMaxed`, `estimatedDailyCapacityUnits`, `maxingCyclesObserved`) anchor on `maxedAt`
- Claude cap-cycle metrics anchor on durable `contribution_cap_exhausted` / `contribution_cap_cleared` lifecycle events, not auth-style `maxed`
- recovery metrics (`avgRecoveryTimeMs`) anchor on `reactivated` timestamps and stay `null` unless at least one completed maxed→reactivated pair lands in-window
- `estimatedDailyCapacityUnits` is the `p50` of per-cycle `usageUnits / cycleDurationDays` and stays `null` unless at least 2 valid cycles exist
- `maxingCyclesObserved` is always numeric; `0` means no maxed cycles were observed in the requested window
- `utilizationRate24h` is trailing 24h `usageUnits / estimatedDailyCapacityUnits`; it stays `null` when capacity is unknown and may exceed `1`
- for Claude, the provider-reported fields above are the authoritative live quota signal; the empirical maxing-cycle fields remain legacy health/capacity heuristics
- `source` is accepted for contract consistency but is non-operative for lifecycle/capacity/utilization fields; derived health values are always credential-global

Response example:
```json
{
  "window": "7d",
  "tokens": [
    {
      "credentialId": "11111111-1111-4111-8111-111111111111",
      "displayKey": "cred_1111...1111",
      "debugLabel": "dylan-anthropic-1",
      "provider": "anthropic",
      "status": "active",
      "consecutiveFailures": 0,
      "lastFailedStatus": null,
      "lastFailedAt": null,
      "maxedAt": "2026-03-07T12:00:00.000Z",
      "nextProbeAt": null,
      "lastProbeAt": "2026-03-08T03:00:00.000Z",
      "monthlyContributionLimitUnits": 500000,
      "monthlyContributionUsedUnits": 123000,
      "monthlyWindowStartAt": "2026-03-01T00:00:00.000Z",
      "maxedEvents7d": 2,
      "requestsBeforeMaxedLastWindow": 340,
      "avgRequestsBeforeMaxed": 287.5,
      "avgUsageUnitsBeforeMaxed": 52000,
      "avgRecoveryTimeMs": 1800000,
      "estimatedDailyCapacityUnits": 156000,
      "maxingCyclesObserved": 2,
      "utilizationRate24h": 1.08,
      "fiveHourReservePercent": 20,
      "fiveHourUtilizationRatio": 0.6,
      "fiveHourResetsAt": "2026-03-07T17:00:00.000Z",
      "fiveHourContributionCapExhausted": false,
      "sevenDayReservePercent": 10,
      "sevenDayUtilizationRatio": 0.72,
      "sevenDayResetsAt": "2026-03-12T00:00:00.000Z",
      "sevenDayContributionCapExhausted": true,
      "providerUsageFetchedAt": "2026-03-07T14:34:00.000Z",
      "claudeFiveHourCapExhaustionCyclesObserved": 2,
      "claudeFiveHourUsageUnitsBeforeCapExhaustionLastWindow": 48000,
      "claudeFiveHourAvgUsageUnitsBeforeCapExhaustion": 47000,
      "claudeSevenDayCapExhaustionCyclesObserved": 1,
      "claudeSevenDayUsageUnitsBeforeCapExhaustionLastWindow": 220000,
      "claudeSevenDayAvgUsageUnitsBeforeCapExhaustion": 220000,
      "createdAt": "2026-02-15T00:00:00.000Z",
      "expiresAt": "2026-06-01T00:00:00.000Z"
    }
  ]
}
```

### `GET /v1/admin/analytics/tokens/routing`
Admin-only routing/error/latency stats per token.

Query params:
- `window`: `5h|24h|7d|1m|all|30d` (`30d` normalizes to `1m`; default `24h`)
- `provider`: `anthropic|openai|codex` (`codex` normalizes to `openai`)
- `source`: `openclaw|cli-claude|cli-codex|direct`

Response example:
```json
{
  "window": "24h",
  "tokens": [
    {
      "credentialId": "11111111-1111-4111-8111-111111111111",
      "displayKey": "cred_1111...1111",
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
- `window`: `5h|24h|7d|1m|all|30d` (`30d` normalizes to `1m`; default `24h`)
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
- `maxedTokens` counts tokens currently at usage capacity, not broken credentials
- for Claude, `maxedTokens` uses the latest provider-reported 5h / 7d utilization against each token's configured reserve
- for non-Claude providers, `maxedTokens` continues to follow the current durable usage-maxed status until provider-usage telemetry exists there

### `GET /v1/admin/analytics/timeseries`
Admin-only chart-series endpoint.

Query params:
- `window`: `5h|24h|7d|1m|all|30d` (`30d` normalizes to `1m`; default `1m`)
- `granularity`: `5m|15m|hour|day`
  - default `5m` for `5h`
  - default `15m` for `24h`
  - default `hour` for `7d`
  - default `day` for `1m|all`
- `provider`: `anthropic|openai|codex` (`codex` normalizes to `openai`)
- `source`: `openclaw|cli-claude|cli-codex|direct`
- `credentialId`: UUID filter

Response example:
```json
{
  "window": "24h",
  "granularity": "15m",
  "series": [
    {
      "date": "2026-03-07T14:15:00.000Z",
      "requests": 145,
      "usageUnits": 32000,
      "errorRate": 0.02,
      "latencyP50Ms": 1300
    }
  ]
}
```

### `GET /v1/admin/analytics/buyers`
Admin-only buyer-key inventory analytics.

Query params:
- `window`: `5h|24h|7d|1m|all|30d` (`30d` normalizes to `1m`; default `24h`)
- `provider`: `anthropic|openai|codex` (`codex` normalizes to `openai`)
- `source`: `openclaw|cli-claude|cli-codex|direct`

Notes:
- inventory-based: includes all `buyer_proxy` keys, including zero-usage rows
- `displayKey` is a safe display fallback, not a raw buyer secret
- `lastSeenAt` is derived from routed traffic, not auth middleware `last_used_at`
- `effectiveProvider` applies the buyer-key default when `preferredProvider` is `null`

Response example:
```json
{
  "window": "24h",
  "buyers": [
    {
      "apiKeyId": "22222222-2222-4222-8222-222222222222",
      "displayKey": "key_2222...2222",
      "label": "openclaw-main",
      "orgId": "33333333-3333-4333-8333-333333333333",
      "orgLabel": "OpenClaw",
      "preferredProvider": null,
      "effectiveProvider": "anthropic",
      "requests": 800,
      "attempts": 820,
      "usageUnits": 180000,
      "retailEquivalentMinor": 5100,
      "percentOfTotal": 0.56,
      "lastSeenAt": "2026-03-07T14:32:00.000Z",
      "errorRate": 0.0122,
      "bySource": {
        "openclaw": { "requests": 800, "usageUnits": 180000 },
        "cli-claude": { "requests": 0, "usageUnits": 0 },
        "cli-codex": { "requests": 0, "usageUnits": 0 },
        "direct": { "requests": 0, "usageUnits": 0 }
      }
    }
  ]
}
```

### `GET /v1/admin/analytics/buyers/timeseries`
Admin-only buyer-key chart-series endpoint.

Query params:
- `window`: `5h|24h|7d|1m|all|30d` (`30d` normalizes to `1m`; default `1m`)
- `granularity`: `5m|15m|hour|day`
  - default `5m` for `5h`
  - default `15m` for `24h`
  - default `hour` for `7d`
  - default `day` for `1m|all`
- `provider`: `anthropic|openai|codex` (`codex` normalizes to `openai`)
- `source`: `openclaw|cli-claude|cli-codex|direct`
- `apiKeyId`: UUID filter; repeat param to request multiple buyer series

Response example:
```json
{
  "window": "24h",
  "granularity": "15m",
  "series": [
    {
      "date": "2026-03-07T14:15:00.000Z",
      "apiKeyId": "22222222-2222-4222-8222-222222222222",
      "requests": 24,
      "usageUnits": 4100,
      "errorRate": 0.0125,
      "latencyP50Ms": 980
    }
  ]
}
```

### `GET /v1/admin/analytics/requests`
Admin-only recent request drill-down. Response content is preview-only by default.

Query params:
- `window`: `5h|24h|7d|1m|all|30d` (`30d` normalizes to `1m`; default `24h`)
- `limit`: `1..200` (default `50`)
- `provider`: `anthropic|openai|codex` (`codex` normalizes to `openai`)
- `source`: `openclaw|cli-claude|cli-codex|direct`
- `credentialId`: UUID filter
- `model`: exact model filter
- `minLatencyMs`: integer `>= 0`

Notes:
- attempt-level endpoint: `requestId` may repeat across retries/failovers
- `attemptNo` identifies the specific attempt row
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
      "attemptNo": 2,
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

### `GET /v1/admin/analytics/events`
Admin-only token lifecycle event feed.

Query params:
- `window`: `5h|24h|7d|1m|all|30d` (`30d` normalizes to `1m`; default `24h`)
- `provider`: `anthropic|openai|codex` (`codex` normalizes to `openai`)
- `limit`: `1..200` (default `50`)

Notes:
- currently reads durable token lifecycle events from `in_token_credential_events`
- does not synthesize anomaly events; use `/anomalies` separately for data-quality checks

Response example:
```json
{
  "window": "24h",
  "limit": 50,
  "events": [
    {
      "id": "event_1",
      "type": "maxed",
      "createdAt": "2026-03-07T14:32:00.000Z",
      "provider": "anthropic",
      "credentialId": "11111111-1111-4111-8111-111111111111",
      "credentialLabel": "dylan-anthropic-1",
      "summary": "credential maxed",
      "severity": "warn",
      "statusCode": 401,
      "reason": "upstream_401_consecutive_failure",
      "metadata": {
        "threshold": 10
      }
    }
  ]
}
```

### `GET /v1/admin/analytics/anomalies`
Admin-only analytics confidence and data-quality checks.

Query params:
- `window`: `5h|24h|7d|1m|all|30d` (`30d` normalizes to `1m`; default `24h`)
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
    "staleAggregateWindows": 1,
    "usageLedgerVsAggregateMismatchCount": 0
  },
  "ok": false
}
```

Notes:
- `staleAggregateWindows` counts daily aggregate windows where raw usage has aged past the refresh SLA but the aggregate row is missing or older than the latest raw row
- `usageLedgerVsAggregateMismatchCount` counts closed daily aggregate windows whose counts do not match raw `entry_type='usage'` ledger rows, including aggregate-only orphan rows
- aggregate anomaly checks honor `provider` but ignore `source`

### `GET /v1/admin/analytics/dashboard`
Admin-only analytics snapshot for the internal dashboard.

Query params:
- `window`: `5h|24h|7d|1m|all|30d` (`30d` normalizes to `1m`; default `24h`)
- `provider`: `anthropic|openai|codex` (`codex` normalizes to `openai`)
- `source`: `openclaw|cli-claude|cli-codex|direct`

Notes:
- returns a best-effort merged snapshot for the UI so summary/tables/anomalies/events share one `snapshotAt`
- `tokens[*]` merges usage, health, and routing metrics by `credentialId`
- `tokens[*].attempts` is attempt-level volume; `tokens[*].requests` is distinct `request_id` count for the same window
- `tokens[*]` also carries the same nullable Claude-only contribution-cap/provider-usage fields as `/v1/admin/analytics/tokens/health`
- `tokens[*]` may also include best-effort auth-diagnosis fields from `/v1/admin/analytics/tokens/health`; the dashboard status text can fold those into backend-`maxed` visibility
- `summary.maxedTokens` counts tokens currently at usage capacity; for Claude that means provider usage has hit the provider ceiling or the configured reserve threshold
- the dashboard UI shows raw Claude provider utilization in `5H` / `7D`; reserve/exhausted fields only control whether those cells are highlighted as effectively exhausted
- non-Claude rows keep those raw API fields `null` and the UI renders `--` in the CAP cells
- `buyers[*]` may include `latencyP50Ms` and `errorRate` when those buyer aggregates are available
- snapshot `events` is currently capped to the 20 most recent lifecycle events
- `warnings` is a free-form operator-facing list for Claude operator issues such as auth-failed parked tokens, missing snapshots, stale snapshots, and contribution-cap exhaustion when the backend emits them

Response example:
```json
{
  "window": "5h",
  "snapshotAt": "2026-03-07T14:35:00.000Z",
  "summary": {
    "totalRequests": 145,
    "totalUsageUnits": 32000,
    "activeTokens": 8,
    "maxedTokens": 1,
    "totalTokens": 10,
    "maxedEvents7d": 4,
    "errorRate": 0.034,
    "fallbackRate": 0.02,
    "byProvider": {
      "anthropic": { "requests": 120, "usageUnits": 28000 },
      "openai": { "requests": 25, "usageUnits": 4000 }
    },
    "byModel": {},
    "bySource": {
      "openclaw": { "requests": 90, "usageUnits": 20000 },
      "cli-claude": { "requests": 40, "usageUnits": 9000 },
      "cli-codex": { "requests": 10, "usageUnits": 2000 },
      "direct": { "requests": 5, "usageUnits": 1000 }
    },
    "translationOverhead": null,
    "topBuyers": []
  },
  "tokens": [
    {
      "credentialId": "11111111-1111-4111-8111-111111111111",
      "displayKey": "cred_1111...1111",
      "debugLabel": "dylan-anthropic-1",
      "provider": "anthropic",
      "status": "active",
      "attempts": 148,
      "requests": 145,
      "usageUnits": 32000,
      "percentOfWindow": 0.64,
      "utilizationRate24h": 1.08,
      "maxedEvents7d": 2,
      "monthlyContributionUsedUnits": 123000,
      "monthlyContributionLimitUnits": 500000,
      "fiveHourReservePercent": 20,
      "fiveHourUtilizationRatio": 0.6,
      "fiveHourResetsAt": "2026-03-07T17:00:00.000Z",
      "fiveHourContributionCapExhausted": false,
      "sevenDayReservePercent": 10,
      "sevenDayUtilizationRatio": 0.72,
      "sevenDayResetsAt": "2026-03-12T00:00:00.000Z",
      "sevenDayContributionCapExhausted": true,
      "providerUsageFetchedAt": "2026-03-07T14:34:00.000Z",
      "claudeFiveHourCapExhaustionCyclesObserved": 2,
      "claudeFiveHourUsageUnitsBeforeCapExhaustionLastWindow": 48000,
      "claudeFiveHourAvgUsageUnitsBeforeCapExhaustion": 47000,
      "claudeSevenDayCapExhaustionCyclesObserved": 1,
      "claudeSevenDayUsageUnitsBeforeCapExhaustionLastWindow": 220000,
      "claudeSevenDayAvgUsageUnitsBeforeCapExhaustion": 220000,
      "latencyP50Ms": 1200,
      "errorRate": 0.02,
      "authFailures24h": 2,
      "rateLimited24h": 3
    }
  ],
  "buyers": [
    {
      "apiKeyId": "22222222-2222-4222-8222-222222222222",
      "displayKey": "key_2222...2222",
      "label": "shirtless",
      "orgId": "33333333-3333-4333-8333-333333333333",
      "orgLabel": "Innies Team",
      "preferredProvider": "openai",
      "effectiveProvider": "openai",
      "requests": 72,
      "usageUnits": 11000,
      "percentOfWindow": 0.34,
      "lastSeenAt": "2026-03-07T14:31:00.000Z",
      "latencyP50Ms": 980,
      "errorRate": 0.011
    }
  ],
  "anomalies": {
    "checks": {
      "missingDebugLabels": 0,
      "unresolvedCredentialIdsInTokenModeUsage": 0,
      "nullCredentialIdsInRouting": 0,
      "staleAggregateWindows": 0,
      "usageLedgerVsAggregateMismatchCount": 0
    },
    "ok": true
  },
  "events": [],
  "warnings": []
}
```

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
  - Default maxing statuses are `401`/`403` allowlisted via `TOKEN_CREDENTIAL_MAX_ON_STATUSES`, with default config still `401`.
  - Default threshold is `10` consecutive matching failures (`TOKEN_CREDENTIAL_MAXED_CONSECUTIVE_FAILURES=10`).
  - OAuth/session creds use a `3x` auth-failure threshold before auto-max (`30` by default).
  - OAuth/session creds also track repeated `429` responses separately:
    - repeated `429`s now use one threshold: `10` consecutive `429`s -> temporary routing penalty (`TOKEN_CREDENTIAL_RATE_LIMIT_CONSECUTIVE_FAILURES=10`)
    - non-Claude OAuth/session creds apply the normal short cooldown duration (`TOKEN_CREDENTIAL_RATE_LIMIT_COOLDOWN_MINUTES=5`)
    - Claude OAuth creds keep repeated-`429` handling local and do not auto-max; once the threshold is hit, routing applies the longer local backoff and recovery comes from provider-usage refresh + fresh quota state rather than a durable `maxed` transition
  - Auto-maxed credentials are removed from active routing pool until probe reactivation for auth-like failures only.
  - Successful routed request on an active/rotating credential resets both auth-failure and `429` counters and clears temporary rate-limit penalties.
  - Token credential probe/reactivation:
  - Background jobs:
    - Claude OAuth auth-failure recovery is supervised by `token-credential-provider-usage-minute`, which checks due auth-broken Claude creds each minute and only probes when `nextProbeAt` is due.
    - the same Claude usage-refresh job also re-checks expired Claude OAuth creds when a stored refresh token exists, so they can auto-refresh back to `active` instead of falling out of quota polling indefinitely.
    - `token-credential-healthcheck-hourly` remains the generic maxed-token probe loop for non-Claude credentials; the job name is legacy, but the default cadence is now 10m.
  - Enabled by default (`TOKEN_CREDENTIAL_PROBE_ENABLED=true`).
  - Schedule default: 10m (`TOKEN_CREDENTIAL_PROBE_SCHEDULE_MS=600000`).
  - Probe timeout default: `10000ms` (`TOKEN_CREDENTIAL_PROBE_TIMEOUT_MS=10000`).
  - Probe batch default: `20` creds (`TOKEN_CREDENTIAL_PROBE_MAX_KEYS=20`).
  - Next probe interval default: 10m (`TOKEN_CREDENTIAL_PROBE_INTERVAL_MINUTES=10`; legacy `TOKEN_CREDENTIAL_PROBE_INTERVAL_HOURS` still works as fallback).
  - Probe model default: `claude-opus-4-6` (`TOKEN_CREDENTIAL_PROBE_MODEL` override).
- Token-mode policy guard:
  - when `TOKEN_MODE_ENABLED_ORGS` is configured, non-allowlisted orgs are blocked deterministically (no legacy fallback)
- Routing telemetry writes include failed attempts with error metadata.
- Safety checks before routing:
  - global/org/model kill switches
  - active provider/model compatibility rule
