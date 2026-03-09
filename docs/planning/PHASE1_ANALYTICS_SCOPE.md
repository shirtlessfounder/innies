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

## Descoped to Post-Merge

These fields stay in the response shape for now, but Phase 1 treats them as deferred and they must return `null`, not fake `0`.

- `translationOverhead` — requires a durable `translated` flag in routing metadata. `/system` returns `null` until that attribution exists end-to-end.
- `requestsBeforeMaxedLastWindow` — requires paired maxed-event analysis across the observed request window. `/tokens/health` returns `null` for now.
- Derived maxing metrics (`avgRequestsBeforeMaxed`, `avgUsageUnitsBeforeMaxed`, `avgRecoveryTimeMs`, `estimatedDailyCapacityUnits`, `maxingCyclesObserved`) — all require paired event analysis not yet implemented. `/tokens/health` returns `null` for all of these.
- `utilizationRate24h` — requires actual 24h usage joined to a real capacity estimate. `/tokens/health` returns `null` for now.
- `staleAggregateWindows` — anomaly check not yet implemented. `/anomalies` returns `null` for now.
- `usageLedgerVsAggregateMismatchCount` — anomaly check not yet implemented. `/anomalies` returns `null` for now.
- `REQUEST_LOG_STORE_FULL` wiring — Phase 1 request-log contract is preview-only. Encrypted full-content storage is deferred even if schema columns already exist.

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
- **No derived maxing metrics surface.** Phase 1 still requires `maxed_events_per_token_7d`; `requests_before_maxed_last_window` is descoped to post-merge and returns `null`.
- **No anomaly/data-quality checks surface.** Missing labels and null credential ids are not surfaced anywhere. Stale-window and aggregate-vs-raw mismatch checks are descoped to post-merge and return `null`.
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

### Request Source Classification

Every analytics endpoint should support slicing by request source. Derived from `route_decision` in `in_routing_events`:

| Source | Detection |
|--------|-----------|
| `openclaw` | prefer explicit `route_decision->>'request_source' = 'openclaw'`; fallback for legacy rows: `openclaw_run_id` is non-null AND `provider_selection_reason != 'cli_provider_pinned'` |
| `cli-claude` | prefer explicit `route_decision->>'request_source' = 'cli-claude'`; fallback: `provider_selection_reason = 'cli_provider_pinned'` AND provider = `anthropic` |
| `cli-codex` | prefer explicit `route_decision->>'request_source' = 'cli-codex'`; fallback: `provider_selection_reason = 'cli_provider_pinned'` AND provider = `openai` |
| `direct` | prefer explicit `route_decision->>'request_source' = 'direct'`; fallback: no `openclaw_run_id` and not cli-pinned |

All endpoints accept optional `source` query param to filter by request source.

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
      "outputTokens": 62000,
      "bySource": {
        "openclaw": { "requests": 300, "usageUnits": 65000 },
        "cli-claude": { "requests": 112, "usageUnits": 24400 }
      }
    }
  ]
}
```

Query params: `window` (`24h`, `7d`, `1m`, `all`), `provider` filter, `source` filter.

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
      "avgRequestsBeforeMaxed": null,
      "avgUsageUnitsBeforeMaxed": null,
      "avgRecoveryTimeMs": null,
      "estimatedDailyCapacityUnits": null,
      "maxingCyclesObserved": null,
      "utilizationRate24h": null,
      "createdAt": "2026-02-15T...",
      "expiresAt": "2026-06-01T..."
    }
  ]
}
```

Source:
- `in_token_credentials` for current credential health state
- `in_token_credential_events` for `maxedEvents7d`
- `requestsBeforeMaxedLastWindow` is descoped to post-merge and returns `null` until paired maxed-event analysis lands
- `utilizationRate24h` is descoped to post-merge and returns `null` until actual 24h usage can be compared against a real capacity estimate

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
      "ttfbP50Ms": 280,
      "ttfbP95Ms": 650,
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
      "apiKeyId": "uuid",
      "orgId": "uuid",
      "requests": 800,
      "usageUnits": 180000,
      "percentOfTotal": 0.56
    }
  ]
}
```

Source: `in_routing_events` + `in_usage_ledger` + `in_token_credentials`.

`translationOverhead` is descoped to post-merge until translated-request attribution is emitted durably enough to validate.

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

### 6. Request Log Endpoint
`GET /v1/admin/analytics/requests`

Returns recent requests with preview detail for debugging and audit.

```json
{
  "window": "24h",
  "limit": 50,
  "requests": [
    {
      "requestId": "uuid",
      "createdAt": "2026-03-07T14:32:00Z",
      "credentialId": "uuid",
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
      "prompt": "[first 500 chars of user message]",
      "response": "[first 500 chars of assistant response]"
    }
  ]
}
```

Query params: `window`, `limit` (max 200), `provider`, `credentialId`, `source`, `model`, `minLatencyMs`.

Source:
- `in_routing_events` joined to `in_usage_ledger` on (`org_id`, `request_id`, `attempt_no`)
- `in_token_credentials` for label
- **New: `in_request_log`** for prompt/response content (see Request Content Storage below)

### Request Content Storage

**New table: `in_request_log`**

Stores truncated prompt and response content for debugging and audit.

Schema:
```sql
create table in_request_log (
  id uuid primary key,
  request_id text not null,
  attempt_no integer not null default 1,
  org_id uuid not null,
  provider text not null,
  model text not null,
  prompt_preview text,        -- first 500 chars of user message
  response_preview text,      -- first 500 chars of assistant response
  full_prompt_encrypted bytea,  -- reserved for post-merge wiring
  full_response_encrypted bytea, -- reserved for post-merge wiring
  created_at timestamptz not null default now()
);

create index idx_request_log_org_created on in_request_log (org_id, created_at desc);
create unique index idx_request_log_org_req_attempt on in_request_log (org_id, request_id, attempt_no);
```

Write path:
- Populated in the proxy route for successful upstream responses
- Preview fields always written (truncated to 500 chars)
- `REQUEST_LOG_STORE_FULL` wiring is deferred; encrypted full-content columns stay unused in Phase 1
- Retention: 30 days default, configurable via `REQUEST_LOG_RETENTION_DAYS`

Privacy/security:
- Admin-only access (same as all analytics endpoints)
- Previews truncated to limit exposure
- Encrypted full-content columns are reserved for follow-up wiring and are not populated in Phase 1
- Retention job deletes rows older than configured window
- Phase 1: internal team only, no external user content unless F&F is live

### TTFB Persistence

**Schema addition to `in_routing_events`:**

```sql
alter table in_routing_events add column ttfb_ms integer;
```

Write path:
- Populated from `firstByteAt - startedAt` which is already computed in the proxy (line ~2363 in proxy.ts)
- Just needs to be passed through to the routing events insert

Surfaced in:
- Request log endpoint (`ttfbMs` field)
- Per-token routing endpoint (add `ttfbP50Ms`, `ttfbP95Ms`)
- System endpoint (add `ttfbP50Ms`, `ttfbP95Ms`)

### 7. Analytics Quality / Anomaly Endpoint
`GET /v1/admin/analytics/anomalies`

Returns data-quality and operability checks needed for Phase 1 confidence.

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

Source:
- `in_token_credentials` for missing labels
- `in_usage_ledger` + `in_routing_events` for unresolved token credential ids on token-mode rows
- stale aggregate and raw-vs-aggregate mismatch checks are descoped to post-merge and return `null`

---

## Implementation Plan

### Phase A: Repository Layer
1. Add `AnalyticsRepository` with query methods:
   - `getTokenUsage(window, provider?, source?)` — aggregated usage per token with source breakdown
   - `getTokenHealth(window?, provider?)` — health + derived maxing metrics + utilization per token
   - `getTokenRouting(window, provider?, source?)` — routing stats per token including TTFB
   - `getSystemSummary(window)` — pool-wide aggregates + source breakdown + top buyers (`translationOverhead` remains `null` in Phase 1)
   - `getTimeSeries(window, granularity, filters?)` — daily/hourly breakdown
   - `getRecentRequests(window, limit, filters?)` — request log with prompt/response previews
   - `getAnomalies(window)` — quality checks for analytics confidence
2. Add percentile helpers (p50/p95 from routing_events latency_ms and ttfb_ms)
3. Add `RequestLogRepository` with:
   - `insert(requestId, orgId, provider, model, promptPreview, responsePreview)` — write on each request
   - `query(window, limit, filters)` — read for request log endpoint
   - `purgeOlderThan(days)` — retention cleanup
3. Add derived-metric helpers for:
   - `maxed_events_per_token_7d`
   - `avg_requests_before_maxed` — average requests per active→maxed cycle across all observed cycles
   - `avg_usage_units_before_maxed` — average usage units consumed per cycle
   - `avg_recovery_time_ms` — average time from maxed→active (via probe reactivation)
   - `estimated_daily_capacity_units` — derived from (avg usage per cycle × cycles per day), gives empirical estimate of provider-side token limit
   - `maxing_cycles_observed` — total count of active→maxed transitions (confidence indicator)
   - auth-failure and rate-limit counts per token/window
4. Add one shared helper for extracting/resolving token credential id from routing metadata
5. Keep canonical window parsing centralized: `24h`, `7d`, `1m`, `all`

### Phase A2: Schema Changes
1. Add `ttfb_ms` column to `in_routing_events`
2. Create `in_request_log` table with indexes
3. Keep request-log full-content columns reserved for post-merge wiring; Phase 1 stays preview-only
4. Add `REQUEST_LOG_RETENTION_DAYS` env config (default 30)
5. Wire prompt/response preview capture into proxy write path
6. Wire `ttfb_ms` into routing events insert
7. Add retention cleanup job for `in_request_log`

### Phase B: API Routes
1. Register all 7 endpoints under `api/src/routes/analytics.ts`
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
7. Verify source classification (openclaw/cli-claude/cli-codex/direct) is accurate
8. Verify request log captures prompt/response previews without leaking full content
9. Verify TTFB percentiles are populated after schema migration

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
- Historical backfill for routing_events older than table creation
- Any full prompt/response storage beyond previews (`REQUEST_LOG_STORE_FULL` wiring is deferred)
- Per-token cost efficiency / ROI metrics (needs pricing model not yet defined)

## Dependencies
- Existing aggregation jobs must be running (they are)
- `in_routing_events` must have enough history for meaningful percentiles
- Admin API key for all endpoints
- Token-mode routing rows must consistently carry `route_decision.tokenCredentialId`

## Exit Criteria
- All 7 endpoints return correct data against production DB
- Test coverage for query logic and route auth
- Numbers cross-checked against raw SQL
- Phase 1 minimum metrics are queryable:
  - `requests_per_token_24h`
  - `success_rate_per_token_24h`
  - `auth_failures_per_token_24h`
  - `rate_limited_per_token_24h`
  - `tokens_processed_per_token_24h`
  - `maxed_events_per_token_7d`
- Per-token capacity estimation metrics are queryable:
  - `avgRequestsBeforeMaxed`, `avgUsageUnitsBeforeMaxed`, `avgRecoveryTimeMs`
  - `estimatedDailyCapacityUnits` derived from maxing cycle history
  - `maxingCyclesObserved` as a confidence indicator (more cycles = better estimate)
- Canonical window set is used consistently: `24h`, `7d`, `1m`, `all`
- Token-mode per-token analytics are correct even when `seller_key_id` is null
- Operator validation/anomaly queries exist and are usable without raw log spelunking
- Request source breakdown (openclaw / cli-claude / cli-codex / direct) works across all endpoints
- Descoped fields return `null`, not fake `0`
- TTFB percentiles available in routing and system endpoints
- Request log captures prompt/response previews with 30-day retention
- Top buyer consumption visible in system endpoint
- `utilizationRate24h` is explicitly deferred and returns `null`
- Feature `5` can build Phase 1 dashboard panels on top of these read APIs without inventing one-off raw SQL per panel
