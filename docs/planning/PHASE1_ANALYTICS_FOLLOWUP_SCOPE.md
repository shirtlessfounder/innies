# Phase 1 Analytics Follow-Up Scope

Purpose:
- scope the deferred but high-value analytics that were intentionally left out of the first Phase 1 analytics ship
- keep the same rule: do not fake green metrics; return `null` until the number is defensible
- give the team an execution-ready plan for three useful follow-ups:
  - maxing-cycle / capacity estimation analytics
  - true utilization-rate analytics
  - stale-aggregate / raw-vs-aggregate mismatch anomaly checks

Related docs:
- `docs/ANALYTICS.md`
- `docs/API_CONTRACT.md`
- `docs/ANALYTICS_VALIDATION.md`
- `docs/planning/PHASE1_ANALYTICS_SCOPE.md`

## Why This Is Follow-Up Work

Phase 1 analytics shipped the exact, low-ambiguity parts:
- per-token usage
- per-token routing
- exact `maxedEvents7d`
- pool-wide routing/system summaries
- request previews
- basic anomaly checks

The deferred metrics were useful, but not trustworthy enough yet:
- capacity metrics need a real maxed-cycle model
- utilization needs a real denominator, not a guessed ratio
- aggregate anomaly checks need explicit freshness and equality rules

## Product Goal

After this follow-up lands, operators should be able to answer:
- which credentials max out quickly vs rarely
- how much work a credential can typically sustain before maxing
- how long credentials take to recover
- whether a credential is currently underused, near capacity, or overloaded
- whether the aggregate pipeline is stale or drifting from raw metering data

## Build Principles

- `null` is better than a lie
- exact event timestamps beat guessed state-derived math
- capacity estimates must surface confidence, not just a number
- aggregate anomaly checks should be exact for closed windows and freshness-bounded for open windows
- raw joins are acceptable for the first ship if query bounds stay narrow and admin-only

## Source Semantics

Keep this explicit so the follow-up implementation does not invent mixed behavior:

- `/v1/admin/analytics/tokens/health`
  - `source` remains accepted for contract consistency
  - for this follow-up, it stays non-operative
  - all lifecycle/capacity/utilization fields are credential-global, not source-scoped
  - do not return source-filtered derived fields next to unfiltered point-in-time credential state; that mixed contract will be hard to reason about
- `/v1/admin/analytics/anomalies`
  - existing routing-shaped checks may continue to honor `source`
  - `staleAggregateWindows` and `usageLedgerVsAggregateMismatchCount` must ignore `source` in the first implementation because `in_daily_aggregates` has no source dimension
  - do not compare source-sliced raw traffic to non-source-shaped aggregate rows

## Current Data We Can Reuse

Already available:
- `in_token_credentials`
- `in_token_credential_events`
- `in_routing_events`
- `in_usage_ledger`
- `in_daily_aggregates`

Important current behavior:
- `in_token_credential_events` already stores `maxed`, `reactivated`, and `probe_failed`
- `in_token_credential_events.metadata` exists, but currently only stores thin metadata
- token credential identity is still reconstructed from `in_routing_events.route_decision->>'tokenCredentialId'`
- `in_daily_aggregates` is seller-key-shaped, which is fine for aggregate-pipeline anomaly checks but not enough for token-capacity math

## Workstream 1: Maxing-Cycle And Capacity Analytics

### Goal
Populate the currently-null health fields with defensible values:
- `requestsBeforeMaxedLastWindow`
- `avgRequestsBeforeMaxed`
- `avgUsageUnitsBeforeMaxed`
- `avgRecoveryTimeMs`
- `estimatedDailyCapacityUnits`
- `maxingCyclesObserved`

### Canonical Cycle Model

Define a credential cycle as:
- cycle start: the later of:
  - credential `created_at`
  - most recent `reactivated` event after the previous `maxed` event
- cycle end: a `maxed` event for that same credential

Define a completed recovery pair as:
- one `maxed` event
- followed later by the next `reactivated` event for the same credential

Notes:
- a credential can have a valid maxing cycle even if it has not recovered yet
- recovery metrics require maxed->reactivated pairing
- capacity estimation should use completed maxing cycles, not current-state guesses

### Metric Definitions

Recommended first-pass formulas:

- `requestsBeforeMaxedLastWindow`
  - the request count for the most recent maxed cycle whose `maxed_at` falls inside the requested window
  - count `distinct request_id` joined through routing rows attributed to that credential

- `avgRequestsBeforeMaxed`
  - average `distinct request_id` count across maxed cycles inside the requested window

- `avgUsageUnitsBeforeMaxed`
  - average `usage_units` consumed from cycle start until the `maxed` event across maxed cycles inside the requested window

- `avgRecoveryTimeMs`
  - average `(reactivated_at - maxed_at)` across completed recovery pairs inside the requested window

- `maxingCyclesObserved`
  - number of maxed cycles used to compute the averages

- `estimatedDailyCapacityUnits`
  - for each valid cycle, compute:
    - `cycle_usage_units / cycle_duration_days`
  - return the `p50` of those per-cycle daily rates
  - require at least `2` valid cycles before returning non-null

### Window Anchoring Rules

Use one explicit rule per metric family:

- maxed-cycle metrics are anchored by `maxed_at`
  - applies to:
    - `requestsBeforeMaxedLastWindow`
    - `avgRequestsBeforeMaxed`
    - `avgUsageUnitsBeforeMaxed`
    - `estimatedDailyCapacityUnits`
    - `maxingCyclesObserved`
- recovery metrics are anchored by `reactivated_at`
  - applies to:
    - `avgRecoveryTimeMs`

Implications:
- a maxed event inside the window with no later recovery can still contribute to maxed-cycle metrics
- that same cycle does not contribute to `avgRecoveryTimeMs` until a later `reactivated` event exists
- `maxingCyclesObserved` counts maxed cycles used for the maxed-cycle/capacity metrics; it is not a recovery-pair count

### Valid-Cycle Rules

To keep the estimate from flapping:
- ignore cycles shorter than 6 hours for daily-capacity estimation
- ignore cycles with zero joined usage rows
- ignore cycles that cannot resolve a credential id from routing rows
- do not use monthly contribution counters as the capacity denominator; they are budget state, not proven provider-side capacity

### Data Model / Write-Path Changes

Recommended minimal write-path upgrade:
- keep using `in_token_credential_events.metadata`
- enrich `maxed` event metadata with:
  - `requestId`
  - `attemptNo`
  - `statusCode`
  - `threshold`
  - `consecutiveFailures`
  - `monthlyContributionUsedUnits`
- enrich `reactivated` metadata with:
  - `previousMaxedAt`
  - `probeSucceededAt`
- enrich `probe_failed` metadata with:
  - `nextProbeAt`
  - `previousMaxedAt`

Important:
- the analytics math should still derive from event timestamps plus raw joins
- metadata enrichment is primarily for debugging, explainability, and easier validation

### Query Strategy

First ship:
- build cycle math directly in `AnalyticsRepository.getTokenHealth()`
- use bounded raw joins across:
  - `in_token_credential_events`
  - `in_routing_events`
  - `in_usage_ledger`

Performance escape hatch:
- if prod data makes the health query too heavy, add a follow-up snapshot table such as `in_token_cycle_analytics`
- do not block the first implementation on a new aggregate table unless raw-query latency is already unacceptable

### Contract Behavior

Return non-null only when the metric is actually supported:
- `requestsBeforeMaxedLastWindow`: non-null with at least 1 maxed cycle in-window
- `avgRequestsBeforeMaxed`: non-null with at least 1 maxed cycle in-window
- `avgUsageUnitsBeforeMaxed`: non-null with at least 1 maxed cycle in-window
- `avgRecoveryTimeMs`: non-null with at least 1 completed recovery pair in-window
- `estimatedDailyCapacityUnits`: non-null with at least 2 valid cycles
- `maxingCyclesObserved`: always numeric

## Workstream 2: True Utilization-Rate Analytics

### Goal
Populate `utilizationRate24h` with a real ratio instead of a guessed monthly-limit proxy.

### Definition

Recommended formula:
- numerator: trailing 24h `usage_units` attributed to the credential
- denominator: `estimatedDailyCapacityUnits`
- result: `usage_units_24h / estimatedDailyCapacityUnits`

### Important Semantics

- do not cap at `1`
- values above `1` are useful; they mean observed 24h load exceeded the current capacity estimate
- return `null` when `estimatedDailyCapacityUnits` is `null` or `0`
- this metric depends on Workstream 1; do not implement it independently

### Optional Companion Fields

Not required for the first pass, but useful if the UI wants more explainability:
- `utilizationState`: `unknown|low|healthy|hot|over_capacity`
- `capacityConfidence`: `low|medium|high`

Recommendation:
- do not expand the public contract with these until the base ratio is stable

## Workstream 3: Aggregate-Pipeline Confidence Checks

### Goal
Make `/v1/admin/analytics/anomalies` catch pipeline drift, not just bad token metadata.

Populate:
- `staleAggregateWindows`
- `usageLedgerVsAggregateMismatchCount`

### `staleAggregateWindows`

Purpose:
- count aggregate windows that should have been refreshed already but are stale

Recommended first definition:
- inspect `in_daily_aggregates.updated_at`
- inspect raw `in_usage_ledger.created_at`
- count `(day, org_id, seller_key_id, provider, model)` windows where:
  - raw rows are limited to `in_usage_ledger.entry_type = 'usage'`
  - raw usage exists for that window
  - aggregate row exists
  - aggregate `updated_at` is older than the freshness SLA for that day window

Freshness SLA:
- current UTC day: stale if `updated_at < now() - interval '20 minutes'`
- previous UTC day: stale if not touched since the nightly compaction should have run
- older closed days: should never be stale unless the row is missing or was mutated without compaction

Missing aggregate rows that should exist:
- count them as stale windows too

Important:
- use the same primary-usage rollup semantics as the current aggregate job
- do not include correction/reversal rows in these checks unless the aggregate pipeline itself starts folding them in

### `usageLedgerVsAggregateMismatchCount`

Purpose:
- count aggregate windows whose rolled-up counts do not equal the raw usage ledger

Recommended first definition:
- recompute raw windows from `in_usage_ledger` grouped by:
  - `day`
  - `org_id`
  - `seller_key_id`
  - `provider`
  - `model`
- only from rows where `entry_type = 'usage'`
- compare against `in_daily_aggregates`
- count windows where any of these differ:
  - `requests_count`
  - `usage_units`
  - `retail_equivalent_minor`

Window scope:
- closed UTC days only for exact mismatch checks
- exclude the current UTC day from exact equality checks because the incremental job intentionally lags raw writes by a small window

Important:
- this is a pipeline-parity check against the aggregate layer as it exists today
- it is not a generalized ledger-reconciliation check across corrections/reversals

### Why Seller-Key-Shaped Checks Are Still Useful

These checks are not token-capacity analytics. They are pipeline-confidence analytics.

Even though `in_daily_aggregates` is seller-key-shaped:
- it is still the system’s aggregate layer
- mismatch/staleness detection tells operators whether rollups are healthy
- that is valuable independently of token-credential analytics

## Recommended Ship Order

### Slice 1: Cycle Model + Recovery Metrics

Land first:
- event-pairing logic
- `requestsBeforeMaxedLastWindow`
- `avgRequestsBeforeMaxed`
- `avgUsageUnitsBeforeMaxed`
- `avgRecoveryTimeMs`
- `maxingCyclesObserved`

Why first:
- this is the foundation for both capacity and utilization

### Slice 2: Capacity Estimate + Utilization

Land next:
- `estimatedDailyCapacityUnits`
- `utilizationRate24h`

Why second:
- both depend on the cycle model being stable

### Slice 3: Aggregate Confidence Checks

Land in parallel or immediately after Slice 2:
- `staleAggregateWindows`
- `usageLedgerVsAggregateMismatchCount`

Why separate:
- different data path
- different correctness concerns
- easy to validate independently of token-cycle math

## Files Likely To Change

Core code:
- `api/src/repos/analyticsRepository.ts`
- `api/src/repos/tokenCredentialRepository.ts`
- `api/src/routes/analytics.ts`
- `api/src/utils/analytics.ts`

Possible query/perf support:
- new migration only if metadata write-path or helper indexes need it
- possible follow-up repo or snapshot job if raw cycle queries are too heavy

Docs:
- `docs/API_CONTRACT.md`
- `docs/ANALYTICS.md`
- `docs/ANALYTICS_VALIDATION.md`

Tests:
- `api/tests/analyticsRepository.test.ts`
- `api/tests/analytics.route.test.ts`
- new token-cycle fixture coverage

## Validation Requirements

Must validate with both mocked tests and raw SQL:

- cycle pairing for a credential with:
  - one maxed event
  - multiple maxed/reactivated cycles
  - a maxed event with no recovery yet
- capacity estimate nullability when evidence is too thin
- utilization > 1 behavior
- aggregate mismatch detection on a seeded bad row
- stale aggregate detection using controlled `updated_at` timestamps
- `/tokens/health` source filter remains a no-op after these follow-ups
- aggregate confidence checks do not change when only `source` is varied

## Merge Gate

Do not call this done until:
- health metrics return non-null only when confidence rules are met
- utilization is derived from estimated daily capacity, not monthly contribution limits
- anomaly checks catch both stale and mismatched aggregate windows
- `docs/API_CONTRACT.md` and `docs/ANALYTICS.md` match the shipped behavior
- `cd api && npm test` passes
- `cd api && npm run build` passes

## Rough Sizing

- Slice 1: medium-large
- Slice 2: small-medium once Slice 1 exists
- Slice 3: medium

Best practical order:
1. cycle model
2. capacity + utilization
3. aggregate confidence checks
