# Phase 1 Analytics: 3-Agent Work Split

Scope:
- Phase 1 feature `3) Per-token analytics gathering`
- Follows `docs/planning/PHASE1_IMPLEMENTATION_SCOPE.md`
- Detailed backend/read-surface scope from `docs/planning/PHASE1_ANALYTICS_SCOPE.md`

Not in scope here:
- full dashboard UI build-out for Phase 1 feature `5`
- realtime metrics / alerts / websockets
- public or buyer-facing analytics expansion

## Shared Contract Before Coding

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
  - `GET /v1/admin/analytics/anomalies`
- Required Phase 1 metrics:
  - `requests_per_token_24h`
  - `success_rate_per_token_24h`
  - `auth_failures_per_token_24h`
  - `rate_limited_per_token_24h`
  - `tokens_processed_per_token_24h`
  - `maxed_events_per_token_7d`
  - `requests_before_maxed_last_window`

Open data-model warning:
- Current schema exposes current/last `maxed_at`, but not an obvious durable history of every `maxed` transition.
- Do not fake `maxed_events_per_token_7d`.
- If current tables cannot support exact counting, Agent 1 should add the smallest durable event source needed before the metric is marked complete.

Open token-identity warning:
- Feature `3` is about token credentials, not seller keys.
- Token-mode analytics cannot assume `seller_key_id` is present in `in_usage_ledger`.
- Current canonical token identity for token-mode traffic is `in_routing_events.route_decision.tokenCredentialId`.
- Default Phase 1 plan: query-level join from `usage_ledger` -> `routing_events` on (`org_id`, `request_id`, `attempt_no`), then join extracted token id to `in_token_credentials`.

## Agent 1 — Data / Query Layer

Owner:
- repository queries
- metric definitions
- derived analytics math

Primary files:
- `api/src/repos/analyticsRepository.ts` (new)
- `api/src/repos/tokenCredentialRepository.ts` if small read helpers are needed
- `api/src/repos/routingEventsRepository.ts` only if query helpers belong there instead
- optional: minimal persistence hook if durable `maxed` transition tracking is missing

Tasks:
1. Build `AnalyticsRepository` query methods:
   - `getTokenUsage(window, provider?)`
   - `getTokenHealth(window?, provider?)`
   - `getTokenRouting(window, provider?)`
   - `getSystemSummary(window)`
   - `getTimeSeries(window, granularity, filters?)`
   - `getAnomalies(window)`
2. Add percentile helpers for `latencyP50Ms` and `latencyP95Ms`.
3. Define exact derived metric formulas:
   - success rate
   - auth failures
   - rate-limited count
   - fallback count/rate
   - `requestsBeforeMaxedLastWindow`
4. Solve `maxedEvents7d` correctly:
   - use durable existing data if available
   - otherwise add minimal persistence for exact transition counting
5. Keep query plan sane:
   - use `in_daily_aggregates` where appropriate for longer windows
   - use raw `in_routing_events` / `in_usage_ledger` where fidelity matters
6. Lock token identity strategy for Phase 1:
   - default to `route_decision->>'tokenCredentialId'`
   - do not build token analytics on `seller_key_id` for token-mode rows

Definition of done:
- all 6 analytics read methods exist
- metric semantics documented in code/tests
- no guessed implementation for `maxedEvents7d`

## Agent 2 — Route / Contract Layer

Owner:
- HTTP surface
- zod validation
- auth / response shape
- app wiring

Primary files:
- `api/src/routes/analytics.ts` (new)
- `api/src/server.ts`
- `api/src/services/runtime.ts` if repo/service wiring is needed
- `docs/API_CONTRACT.md`

Tasks:
1. Create `api/src/routes/analytics.ts`.
2. Implement all 6 admin-only endpoints.
3. Add query-param schemas:
   - `window`
   - `provider`
   - `granularity`
   - `credentialId` where needed
4. Normalize `30d` request alias -> `1m` canonical output.
5. Lock stable response shapes for dashboard/API consumers.
6. Wire route into express app.
7. Update durable API docs with request/response examples.

Definition of done:
- route file registered and reachable
- auth/validation behavior deterministic
- response payloads match the agreed contract exactly

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
   - percentile calculations
   - derived maxing metrics
   - anomaly checks
   - token-mode analytics when `seller_key_id` is null
2. Write raw SQL validation queries for each endpoint.
3. Cross-check endpoint output vs raw SQL on real data.
4. Verify anomaly endpoint:
   - clean data => green
   - seeded bad fixtures => catches problems
5. Produce consumer handoff mapping:
   - which endpoint powers which future dashboard panel
6. Capture caveats/gaps blocking Phase 1 exit.

Definition of done:
- analytics endpoints have trustworthy validation evidence
- tests catch contract drift
- dashboard team can consume analytics endpoints without re-deriving metric meaning

## Recommended Parallelism

Start immediately in parallel after contract checkpoint:
- Agent 1: repository/query layer
- Agent 2: route scaffolding + schema/contract stubs
- Agent 3: test plan + raw SQL validation matrix

Dependency edges:
- Agent 2 should not freeze final response fields until Agent 1 locks metric definitions.
- Agent 3 should review Agent 1 metric formulas before writing final assertions.
- If Agent 1 needs new durable `maxed` transition persistence, Agent 2 must expose the resulting metric only after that lands.
- If Agent 1 confirms query-level token joins are the Phase 1 path, Agent 2 and Agent 3 should treat that as the canonical contract.

## Contract Checkpoint

Before merge, all 3 agents agree on:
- exact field names
- exact window semantics
- exact success/error/fallback definitions
- exact `requestsBeforeMaxedLastWindow` definition
- exact data source for `maxedEvents7d`
- exact token-id source for token-mode analytics
- exact anomaly checks included in `/anomalies`

## Merge Order

1. Agent 1 lands query layer + any minimal persistence support.
2. Agent 2 lands route layer on top of real query methods.
3. Agent 3 lands/finishes tests, validation evidence, and doc cleanup.
4. Run focused analytics gate.
5. Fold evidence back into Phase 1 docs.

## Focused Gate

Minimum gate before calling feature `3` done:
- analytics repository tests green
- analytics route tests green
- endpoint auth/validation checked
- raw SQL cross-check completed for all 6 endpoints
- Phase 1 required metrics queryable
- no guessed or approximate `maxedEvents7d` metric shipped as if exact

## Suggested Deliverables By Agent

Agent 1 ships:
- `api/src/repos/analyticsRepository.ts`
- any minimal persistence/query support required for exact maxed metrics

Agent 2 ships:
- `api/src/routes/analytics.ts`
- express wiring
- API contract updates

Agent 3 ships:
- analytics tests
- validation SQL snippets / evidence notes
- dashboard consumer mapping

## Done / Not Done Rule

This work split completes Phase 1 feature `3` when:
- analytics data is queryable, validated, and documented

This work split does not by itself complete Phase 1 feature `5` unless a separate dashboard surface is also wired to these endpoints.
