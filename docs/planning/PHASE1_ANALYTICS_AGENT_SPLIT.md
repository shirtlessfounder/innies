# Phase 1 Analytics: 3-Agent Work Split

Scope:
- Phase 1 feature `3) Per-token analytics gathering`
- Follows `docs/planning/PHASE1_IMPLEMENTATION_SCOPE.md`
- Must stay aligned with `docs/planning/PHASE1_ANALYTICS_SCOPE.md`

Not in scope here:
- full dashboard UI build-out for Phase 1 feature `5`
- realtime metrics / alerts / websockets
- public or buyer-facing analytics expansion

Execution rule:
- This doc is execution-ready only if it matches the canonical feature-3 scope.
- If the team wants to defer `/requests`, request-log storage, TTFB persistence, or source slicing, update `docs/planning/PHASE1_ANALYTICS_SCOPE.md` first.

## Descoped Items

These items stay in the route shape for compatibility, but Phase 1 no longer treats them as required shipped metrics/features:

- `translationOverhead` — `/system` returns `null` until translated-request attribution is durable.
- `requestsBeforeMaxedLastWindow` — `/tokens/health` returns `null` until paired maxed-event analysis lands.
- `staleAggregateWindows` — `/anomalies` returns `null` until the stale-aggregate check exists.
- `usageLedgerVsAggregateMismatchCount` — `/anomalies` returns `null` until raw-vs-aggregate mismatch validation exists.
- `REQUEST_LOG_STORE_FULL` wiring — preview request-log storage stays in scope; full encrypted content wiring is deferred.

## Pre-Coding Contract Checkpoint

Must complete before parallel coding starts.

Lock these first:
- Canonical windows: `24h`, `7d`, `1m`, `all`
- `30d` may be accepted as request alias, but responses/docs use `1m`
- Admin-only endpoints under `/v1/admin/analytics/*`
- Canonical endpoints:
  - `GET /v1/admin/analytics/tokens`
  - `GET /v1/admin/analytics/tokens/health`
  - `GET /v1/admin/analytics/tokens/routing`
  - `GET /v1/admin/analytics/system`
  - `GET /v1/admin/analytics/timeseries`
  - `GET /v1/admin/analytics/requests`
  - `GET /v1/admin/analytics/anomalies`
- Every analytics endpoint accepts optional `source` filtering using:
  - `openclaw`
  - `cli-claude`
  - `cli-codex`
  - `direct`
- Routing/system/request surfaces expose TTFB where feature scope requires it
- Required Phase 1 metrics:
  - `requests_per_token_24h`
  - `success_rate_per_token_24h`
  - `auth_failures_per_token_24h`
  - `rate_limited_per_token_24h`
  - `tokens_processed_per_token_24h`
  - `maxed_events_per_token_7d`
- Request-log contract for Phase 1:
  - preview fields only by default
  - `REQUEST_LOG_STORE_FULL` not yet wired
  - 30-day retention by default

Open data-model warning:
- Current schema exposes current/last `maxed_at`, but not an obvious durable history of every `maxed` transition.
- Do not fake `maxed_events_per_token_7d`.
- If current tables cannot support exact counting, Agent 1 must add the smallest durable event source needed before the metric is marked complete.

Open token-identity warning:
- Feature `3` is about token credentials, not seller keys.
- Token-mode analytics cannot assume `seller_key_id` is present in `in_usage_ledger`.
- Current canonical token identity for token-mode traffic is `in_routing_events.route_decision.tokenCredentialId`.
- Default Phase 1 plan: query-level join from `usage_ledger` -> `routing_events` on (`org_id`, `request_id`, `attempt_no`), then join extracted token id to `in_token_credentials`.

Open source-classification warning:
- Request source is part of the feature contract, not optional garnish.
- Source classification must come from routing metadata, not request-path heuristics.
- Fallback/routing math must stay compatible with explicit `request_source` and with legacy `provider_selection_reason` / `openclaw_run_id` fields already emitted today.

## Agent 1 — Data / Query + Minimal Persistence Layer

Owner:
- repository queries
- metric definitions
- derived analytics math
- smallest required persistence/job support for feature `3`

Primary files:
- `api/src/repos/analyticsRepository.ts` (new)
- `api/src/repos/requestLogRepository.ts` (new)
- `api/src/repos/routingEventsRepository.ts`
- `api/src/repos/tokenCredentialRepository.ts` if small read helpers are needed
- `api/src/routes/proxy.ts` if request-log / TTFB write hooks belong there
- `api/src/jobs/*` only if retention or durable persistence support is needed

Tasks:
1. Build `AnalyticsRepository` query methods:
   - `getTokenUsage(window, provider?, source?)`
   - `getTokenHealth(window?, provider?)`
   - `getTokenRouting(window, provider?, source?)`
   - `getSystemSummary(window, source?)`
   - `getTimeSeries(window, granularity, filters?)`
   - `getRecentRequests(window, limit, filters?)`
   - `getAnomalies(window)`
2. Build `RequestLogRepository` methods:
   - `insert(...)`
   - `query(...)`
   - `purgeOlderThan(days)`
3. Land the smallest persistence changes required for feature correctness:
   - durable `maxed` transition source if current data cannot support exact `maxedEvents7d`
   - `ttfb_ms` persistence on routing events
   - request-log preview persistence
   - request-log retention cleanup path
4. Add percentile helpers for:
   - `latencyP50Ms`
   - `latencyP95Ms`
   - `ttfbP50Ms`
   - `ttfbP95Ms`
5. Define exact derived metric formulas:
   - success rate
   - auth failures
   - rate-limited count
   - fallback count/rate
6. Lock shared helpers for:
   - token credential id extraction/resolution
   - source classification
   - canonical window parsing
7. Keep query plan sane:
   - use `in_daily_aggregates` where appropriate for longer windows
   - use raw `in_routing_events` / `in_usage_ledger` where fidelity matters
   - do not build token analytics on `seller_key_id` for token-mode rows

Definition of done:
- all 7 analytics read methods exist
- request-log read/write path exists for Phase 1 preview contract
- TTFB is queryable where the feature scope requires it
- metric semantics documented in code/tests
- no guessed implementation for `maxedEvents7d`

## Agent 2 — Route / Contract Layer

Owner:
- HTTP surface
- zod validation
- auth / response shape
- app wiring
- durable API docs

Primary files:
- `api/src/routes/analytics.ts` (new)
- `api/src/server.ts`
- `api/src/services/runtime.ts` if repo wiring is needed
- `docs/API_CONTRACT.md`

Tasks:
1. Create `api/src/routes/analytics.ts`.
2. Implement all 7 admin-only endpoints.
3. Add query-param schemas for:
   - `window`
   - `provider`
   - `source`
   - `granularity`
   - `credentialId`
   - `limit`
   - `model`
   - `minLatencyMs`
   - any other request-log filters required by the locked contract
4. Normalize `30d` request alias -> `1m` canonical output.
5. Lock stable response shapes for dashboard/API consumers, including:
   - source breakdowns
   - TTFB fields
   - request-log preview fields
6. Wire route into express app.
7. Update durable API docs with request/response examples for all 7 endpoints.

Definition of done:
- route file registered and reachable
- auth/validation behavior deterministic
- response payloads match the agreed contract exactly
- `/requests` is either shipped or explicitly removed from canonical scope before merge

## Agent 3 — Validation / Tests / Ops Handoff

Owner:
- correctness proof
- regression coverage
- raw SQL cross-checks
- dashboard-consumer handoff notes

Primary files:
- `api/tests/*` new analytics tests
- `docs/planning/PHASE1_ANALYTICS_SCOPE.md`
- `docs/JOBS_AND_DATAFLOW.md` if validation/runbook notes belong there
- optional small handoff note for UI consumers

Tasks:
1. Add tests for:
   - repository query correctness
   - route auth/validation
   - latency percentile calculations
   - TTFB percentile calculations
   - derived maxing metrics
   - anomaly checks
   - source classification (`openclaw` / `cli-claude` / `cli-codex` / `direct`)
   - token-mode analytics when `seller_key_id` is null
   - request-log preview capture/truncation without full-content leakage by default
2. Write raw SQL validation queries for each endpoint.
3. Cross-check endpoint output vs raw SQL on real data.
4. Verify anomaly endpoint:
   - clean data => green
   - seeded bad fixtures => catches problems
5. Verify at least one token-mode request can be traced end-to-end through:
   - response/request id evidence
   - `in_routing_events`
   - request-log row when enabled for preview storage
   - analytics endpoint row
6. Produce consumer handoff mapping:
   - which endpoint powers which future dashboard panel
7. Capture caveats/gaps blocking Phase 1 exit.

Definition of done:
- analytics endpoints have trustworthy validation evidence
- tests catch contract drift
- dashboard team can consume analytics endpoints without re-deriving metric meaning

## Recommended Parallelism

Start immediately in parallel after the pre-coding contract checkpoint:
- Agent 1: repository/query layer + minimal persistence scaffolding
- Agent 2: route scaffolding + schema/contract stubs
- Agent 3: test plan + raw SQL validation matrix

Dependency edges:
- Agent 2 should not freeze final response fields until Agent 1 locks metric definitions.
- Agent 3 should review Agent 1 metric formulas before writing final assertions.
- If Agent 1 needs new durable `maxed` transition persistence, Agent 2 must expose the resulting metric only after that lands.
- If Agent 1 confirms query-level token joins are the Phase 1 path, Agent 2 and Agent 3 should treat that as the canonical token-id contract.
- If Agent 1 lands TTFB/request-log schema changes, Agent 2 and Agent 3 should treat those as required feature-3 surface, not optional extras.

## Merge Order

1. Agent 1 lands query layer + any minimal persistence/job support.
2. Agent 2 lands route layer on top of real query methods.
3. Agent 3 lands/finishes tests, validation evidence, and doc cleanup.
4. Run focused analytics gate.
5. Fold evidence back into Phase 1 docs.

## Focused Gate

Minimum gate before calling feature `3` done:
- endpoint auth/validation checked
- current mocked analytics route tests green
- request-log route/repository checks green where present
- source classification checked
- TTFB persisted and queryable where contract requires it
- raw SQL cross-check completed for all 7 endpoints
- Phase 1 required metrics queryable
- no guessed or approximate `maxedEvents7d` metric shipped as if exact
- repo-level analytics query tests and broader route coverage are deferred to follow-up; this weakens the gate

## Suggested Deliverables By Agent

Agent 1 ships:
- `api/src/repos/analyticsRepository.ts`
- `api/src/repos/requestLogRepository.ts`
- any minimal persistence/query/job support required for exact maxed metrics, TTFB, and request-log retention

Agent 2 ships:
- `api/src/routes/analytics.ts`
- express/runtime wiring
- API contract updates

Agent 3 ships:
- analytics tests
- validation SQL snippets / evidence notes
- dashboard consumer mapping

## Done / Not Done Rule

This work split completes Phase 1 feature `3` when:
- analytics data is queryable, validated, and documented
- request-log preview path and TTFB fields required by canonical feature scope are in place
- dashboard feature `5` can consume the read APIs without bespoke SQL

This work split does not by itself complete Phase 1 feature `5` unless a separate dashboard surface is also wired to these endpoints.
