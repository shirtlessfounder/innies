# Phase 1: Per-Token Analytics Scope

## What Exists

### Data Sources (live, writing data now)
- **`in_usage_ledger`** — every request logged: org, seller_key_id, provider, model, input/output tokens, usage_units, retail_equivalent_minor, timestamps
- **`in_routing_events`** — every routing decision: request_id, attempt_no, provider, model, upstream_status, error_code, latency_ms, route_decision JSON
- **`in_daily_aggregates`** — rolled up from usage_ledger: day × org × seller_key × provider × model → requests_count, usage_units, retail_equivalent_minor
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

---

## Scope

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

Query params: `window` (24h, 7d, 30d, all), `provider` filter.

Source: join `in_usage_ledger` (or `in_daily_aggregates` for 7d+) with `in_token_credentials` on seller_key_id.

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
      "createdAt": "2026-02-15T...",
      "expiresAt": "2026-06-01T..."
    }
  ]
}
```

Source: `in_token_credentials` directly. No joins needed.

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
      "fallbackCount": 3
    }
  ]
}
```

Source: `in_routing_events` aggregated by seller_key_id.

Query params: `window` (24h, 7d, 30d), `provider` filter.

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
  "totalTokens": 10
}
```

Source: `in_routing_events` + `in_usage_ledger` + `in_token_credentials`.

### 5. Time-Series Endpoint
`GET /v1/admin/analytics/timeseries`

Returns daily breakdown for charting.

```json
{
  "window": "30d",
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

---

## Implementation Plan

### Phase A: Repository Layer
1. Add `AnalyticsRepository` with query methods:
   - `getTokenUsage(window, provider?)` — aggregated usage per token
   - `getTokenRouting(window, provider?)` — routing stats per token from routing_events
   - `getSystemSummary(window)` — pool-wide aggregates
   - `getTimeSeries(window, granularity, filters?)` — daily/hourly breakdown
2. Add percentile helpers (p50/p95 from routing_events latency_ms)

### Phase B: API Routes
1. Register all 5 endpoints under `api/src/routes/analytics.ts`
2. All admin-only (`requireApiKey(['admin'])`)
3. Input validation via zod schemas
4. Wire into express app

### Phase C: Tests
1. Unit tests for repository queries (mock db or test fixtures)
2. Route-level tests for auth, validation, response shape
3. Verify percentile calculations

### Phase D: Validation
1. Hit each endpoint against prod data
2. Cross-check numbers against raw SQL queries
3. Verify latency percentiles are plausible

---

## Out of Scope
- Dashboard UI (separate Phase 1 item)
- Real-time streaming metrics / websocket feeds
- Alerting / threshold notifications
- Per-buyer-key analytics (could add later, not Phase 1)
- Historical backfill for routing_events older than table creation

## Dependencies
- Existing aggregation jobs must be running (they are)
- `in_routing_events` must have enough history for meaningful percentiles
- Admin API key for all endpoints

## Exit Criteria
- All 5 endpoints return correct data against production DB
- Test coverage for query logic and route auth
- Numbers cross-checked against raw SQL
