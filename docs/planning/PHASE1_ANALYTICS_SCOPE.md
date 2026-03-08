# Phase 1: Per-Token Analytics Scope

Purpose:
- This doc is the implementation slice for Phase 1 feature `3) Per-token analytics gathering` from `docs/planning/PHASE1_IMPLEMENTATION_SCOPE.md`.
- Implemented fully, this should satisfy the Phase 1 per-token analytics feature without also trying to absorb Phase 1 feature `5) Internal usage dashboard`.
- Dashboard UI/surfaces stay in feature `5`; this doc is the backend/read-path slice only.
- Feature `3` is not done until the token-mode attribution model is validated against real data and the resulting endpoints are stable enough for feature `5` to consume without bespoke SQL.
- Validation/results from this slice should feed the eventual Phase 1 exit artifact `docs/planning/PHASE1_DONE_CHECKLIST.md`.

Canonical analytics windows for Phase 1:
- `24h`
- `7d`
- `1m`
- `all`

Implementation note:
- `30d` may be accepted as an API alias for `1m`, but Phase 1 docs and response payloads should use `1m` as the canonical name.

## What Exists

### Data Sources (live, writing data now)
- **`in_usage_ledger`** — every request logged: org, seller_key_id, provider, model, input/output tokens, usage_units, retail_equivalent_minor, timestamps. Important: token-mode writes currently leave `seller_key_id` null.
- **`in_routing_events`** — every routing decision: request_id, attempt_no, provider, model, upstream_status, error_code, latency_ms, route_decision JSON. Important: token-mode writes `route_decision.tokenCredentialId`.
- **`in_daily_aggregates`** — rolled up from usage_ledger: day × org × seller_key × provider × model → requests_count, usage_units, retail_equivalent_minor. Important: this is seller-key-shaped, not token-credential-shaped.
- **`in_token_credentials`** — credential metadata: status (active/maxed/expired/revoked), debug_label, consecutive_failure_count, last_failed_status, maxed_at, next_probe_at

### Jobs (running)
- **daily-aggregates-incremental-5m** — upserts daily aggregates every 5 min from recent usage_ledger rows
- **daily-aggregates-nightly-compaction** — touches yesterday's aggregates for consistency

### Endpoints (live)
- `GET /v1/usage/me` — org-level summary (total requests, usage units, retail equivalent) for last N days
- `GET /v1/admin/pool-health` — seller key status counts (active/maxed/etc)

### What's Missing
- **No per-token read endpoints.** Aggregates are computed but there's no API to query them.
- **No per-token health view.** Token credential health data (failure counts, maxed events, probe state) isn't exposed through any endpoint.
- **No routing analytics.** Routing events are logged but not queryable through an API.
- **No time-series breakdown.** Usage/me returns one number, not a daily/hourly curve.
- **No derived maxing metrics surface.** Phase 1 requires `maxed_events_per_token_7d` and `requests_before_maxed_last_window`, but they are not currently queryable.
- **No anomaly/data-quality checks surface.** Missing labels, null credential ids, stale windows, and aggregate-vs-raw mismatches are not surfaced anywhere.
- **Token identity mismatch on the current hot path.** Feature `3` is about token credentials, but the current warehouse-ish tables are still keyed around `seller_key_id`.

### Important Constraint: Token Credential Identity

Phase 1 feature `3` is about **token credentials** (`in_token_credentials`), not seller keys (`in_seller_keys`).

Current runtime behavior:
- token-mode routing writes `route_decision.tokenCredentialId` into `in_routing_events`
- token-mode usage rows do **not** populate `seller_key_id`
- `in_usage_ledger` currently has no first-class `token_credential_id` column

Implication:
- Per-token analytics cannot rely on `seller_key_id` joins for token-mode traffic.

Phase 1 implementation strategies:

#### Strategy A — Query-Level Join (default recommendation)
- Treat `route_decision->>'tokenCredentialId'` as the canonical token id for token-mode analytics.
- Join `in_usage_ledger` to `in_routing_events` on (`org_id`, `request_id`, `attempt_no`).
- Join the extracted token id to `in_token_credentials` for label/status/provider fields.

Pros:
- No schema migration required.
- Smallest Phase 1 change.

Cons:
- More complex queries.
- `in_daily_aggregates` is less useful for token-level analytics unless token identity is reconstructable.

#### Strategy B — First-Class Token Credential ID
- Add `token_credential_id` to the analytics hot-path tables that need it (`in_usage_ledger`; optionally `in_daily_aggregates`).
- Populate it directly on token-mode writes.

Pros:
- Cleaner query model.
- Better long-term analytics ergonomics.

Cons:
- Requires schema + write-path changes.
- Bigger Phase 1 scope.

Phase 1 recommendation:
- Use **Strategy A** unless query complexity becomes a real blocker.
- Do not block feature `3` on a schema redesign unless analytics correctness cannot be achieved otherwise.

---

## Scope

Boundary note:
- Pool/provider/token-level read APIs are in scope here.
- Per-buyer/per-buyer-key dashboard panels are not required to close feature `3`; if needed, they belong to feature `5` or a later dedicated analytics slice.

### 1. Per-Token Usage Endpoint
`GET /v1/admin/analytics/tokens`

Returns per-token usage breakdown for the pool.

```json
{
  "window": "7d",
  "tokens": [
    {
      "credentialId": "uuid",
      "debugLabel": "dylan-anthropic-1",
      "provider": "anthropic",
      "status": "active",
      "requests": 412,
      "usageUnits": 89400,
      "retailEquivalentMinor": 15200,
      "inputTokens": 1240000,
      "outputTokens": 62000
    }
  ]
}
```

Query params: `window` (`24h`, `7d`, `1m`, `all`), `provider` filter.

Source:
- Token-mode canonical path: join `in_usage_ledger` to `in_routing_events` on (`org_id`, `request_id`, `attempt_no`), extract `route_decision->>'tokenCredentialId'`, then join to `in_token_credentials`.
- `in_daily_aggregates` may be used only where token identity is preserved or reconstructable; otherwise raw-event joins stay canonical.

### 2. Per-Token Health Endpoint
`GET /v1/admin/analytics/tokens/health`

Returns credential health state for all tokens in the pool.

```json
{
  "tokens": [
    {
      "credentialId": "uuid",
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
      "monthlyWindowStartAt": "2026-03-01T00:00:00Z",
      "maxedEvents7d": 0,
      "requestsBeforeMaxedLastWindow": null,
      "createdAt": "2026-02-15T...",
      "expiresAt": "2026-06-01T..."
    }
  ]
}
```

Source:
- `in_token_credentials` for current credential health state
- `in_routing_events` for `maxedEvents7d`
- derived aggregate from recent routing/usage windows for `requestsBeforeMaxedLastWindow`

### 3. Per-Token Routing Analytics
`GET /v1/admin/analytics/tokens/routing`

Returns routing performance per token.

```json
{
  "window": "24h",
  "tokens": [
    {
      "credentialId": "uuid",
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
      "fallbackCount": 3,
      "authFailures24h": 2,
      "rateLimited24h": 3
    }
  ]
}
```

Source: `in_routing_events` aggregated by `route_decision->>'tokenCredentialId'` and joined to `in_token_credentials`.

Query params: `window` (`24h`, `7d`, `1m`), `provider` filter.

### 4. System-Level Analytics
`GET /v1/admin/analytics/system`

Returns pool-wide stats.

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
  "errorRate": 0.034,
  "fallbackRate": 0.02,
  "activeTokens": 8,
  "maxedTokens": 1,
  "totalTokens": 10,
  "maxedEvents7d": 4
}
```

Source: `in_routing_events` + `in_usage_ledger` + `in_token_credentials`.

### 5. Time-Series Endpoint
`GET /v1/admin/analytics/timeseries`

Returns daily breakdown for charting.

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

Source: `in_daily_aggregates` for usage, `in_routing_events` for latency/errors.

Query params: `window`, `granularity` (hour, day), `provider`, `credentialId`.

### 6. Analytics Quality / Anomaly Endpoint
`GET /v1/admin/analytics/anomalies`

Returns data-quality and operability checks needed for Phase 1 confidence.

```json
{
  "window": "24h",
  "checks": {
    "missingDebugLabels": 0,
    "unresolvedCredentialIdsInTokenModeUsage": 0,
    "nullCredentialIdsInRouting": 0,
    "staleAggregateWindows": 0,
    "usageLedgerVsAggregateMismatchCount": 0
  },
  "ok": true
}
```

Source:
- `in_token_credentials` for missing labels
- `in_usage_ledger` + `in_routing_events` for unresolved token credential ids on token-mode rows
- `in_daily_aggregates` recency + raw-vs-aggregate comparison for stale/mismatch checks

---

## Implementation Plan

### Phase A: Repository Layer
1. Add `AnalyticsRepository` with query methods:
   - `getTokenUsage(window, provider?)` — aggregated usage per token
   - `getTokenHealth(window?, provider?)` — health + derived maxing metrics per token
   - `getTokenRouting(window, provider?)` — routing stats per token from routing_events
   - `getSystemSummary(window)` — pool-wide aggregates
   - `getTimeSeries(window, granularity, filters?)` — daily/hourly breakdown
   - `getAnomalies(window)` — quality checks for analytics confidence
2. Add percentile helpers (p50/p95 from routing_events latency_ms)
3. Add derived-metric helpers for:
   - `maxed_events_per_token_7d`
   - `requests_before_maxed_last_window`
   - auth-failure and rate-limit counts per token/window
4. Add one shared helper for extracting/resolving token credential id from routing metadata
5. Keep canonical window parsing centralized: `24h`, `7d`, `1m`, `all`

### Phase B: API Routes
1. Register all 6 endpoints under `api/src/routes/analytics.ts`
2. All admin-only (`requireApiKey(['admin'])`)
3. Input validation via zod schemas
4. Wire into express app

### Phase C: Tests
1. Unit tests for repository queries (mock db or test fixtures)
2. Route-level tests for auth, validation, response shape
3. Verify percentile calculations
4. Verify derived maxing metrics and anomaly checks
5. Verify token-mode analytics work when `seller_key_id` is null
6. Verify fallback counts come from routing metadata, not heuristics

### Phase D: Validation
1. Hit each endpoint against prod data
2. Cross-check numbers against raw SQL queries
3. Verify latency percentiles are plausible
4. Verify anomaly endpoint stays green on healthy data and catches seeded bad fixtures
5. Verify at least one token-mode request can be traced end-to-end:
   - request id / response header
   - `in_routing_events`
   - analytics endpoint row

### Phase E: Docs / Export Helpers
1. Add raw SQL snippets used for validation to durable docs or test fixtures
2. Add one curl example per analytics endpoint
3. Add one dashboard-consumer example showing which endpoint powers which Phase 1 panel
4. Add operator query snippets for:
   - bad token / repeated auth failures
   - rate-limit wave
   - latency spike
   - fallback spike
5. Add one short note clarifying that dashboard feature `5` should consume these endpoints rather than introducing direct DB-only dashboards as the default path

---

## Out of Scope
- Dashboard UI (separate Phase 1 item)
- Real-time streaming metrics / websocket feeds
- Alerting / threshold notifications
- Per-buyer-key analytics (could add later, not Phase 1)
- Historical backfill for routing_events older than table creation
- Large schema redesign unless the query-level join path proves unworkable

## Dependencies
- Existing aggregation jobs must be running (they are)
- `in_routing_events` must have enough history for meaningful percentiles
- Admin API key for all endpoints
- Token-mode routing rows must consistently carry `route_decision.tokenCredentialId`

## Exit Criteria
- All 6 endpoints return correct data against production DB
- Test coverage for query logic and route auth
- Numbers cross-checked against raw SQL
- Phase 1 minimum metrics are queryable:
  - `requests_per_token_24h`
  - `success_rate_per_token_24h`
  - `auth_failures_per_token_24h`
  - `rate_limited_per_token_24h`
  - `tokens_processed_per_token_24h`
  - `maxed_events_per_token_7d`
  - `requests_before_maxed_last_window`
- Canonical window set is used consistently: `24h`, `7d`, `1m`, `all`
- Token-mode per-token analytics are correct even when `seller_key_id` is null
- Operator validation/anomaly queries exist and are usable without raw log spelunking
- Feature `5` can build Phase 1 dashboard panels on top of these read APIs without inventing one-off raw SQL per panel
