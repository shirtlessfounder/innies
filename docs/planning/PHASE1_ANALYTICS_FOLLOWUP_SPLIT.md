# Phase 1 Analytics Follow-Up Split — 3 Agents

Source:
- `docs/planning/PHASE1_ANALYTICS_FOLLOWUP_SCOPE.md`

Goal:
- land the deferred but useful analytics without regressing the “no fake green metrics” rule
- ship real maxing/capacity analytics
- ship real utilization
- ship real aggregate-pipeline confidence checks

Rule:
- do not backfill fake values
- any metric that does not meet the confidence rules in the scope doc must still return `null`

## Pre-Coding Checkpoint

Treat these scope additions as locked:

- `/v1/admin/analytics/tokens/health`
  - `source` stays accepted
  - `source` stays non-operative for lifecycle/capacity/utilization fields in this follow-up
- `/v1/admin/analytics/anomalies`
  - existing routing-shaped checks may honor `source`
  - `staleAggregateWindows` and `usageLedgerVsAggregateMismatchCount` must ignore `source`
- Window anchoring rules:
  - maxed-cycle metrics anchor on `maxed_at`
  - recovery metrics anchor on `reactivated_at`
- `estimatedDailyCapacityUnits`
  - use per-cycle daily rates
  - return `p50`
  - require at least 2 valid cycles
- `utilizationRate24h`
  - `usage_units_24h / estimatedDailyCapacityUnits`
  - do not cap at `1`
- Aggregate mismatch math:
  - compare only `entry_type = 'usage'` raw rows
  - closed UTC days only for exact mismatch checks

## Agent 1 — Cycle Model + Health/Utilization Metrics

Owner:
- token lifecycle math
- health query implementation
- token-event metadata enrichment
- utilization math
- health response semantics

Primary files:
- `api/src/repos/analyticsRepository.ts`
- `api/src/repos/tokenCredentialRepository.ts`

Tasks:
1. Enrich token credential event metadata on:
   - `maxed`
   - `reactivated`
   - `probe_failed`
2. Build canonical cycle pairing logic from `in_token_credential_events`:
   - cycle start from `created_at` or the prior `reactivated`
   - cycle end at `maxed`
   - recovery pair as `maxed -> next reactivated`
3. Implement non-null health metrics:
   - `requestsBeforeMaxedLastWindow`
   - `avgRequestsBeforeMaxed`
   - `avgUsageUnitsBeforeMaxed`
   - `avgRecoveryTimeMs`
   - `maxingCyclesObserved`
4. Implement `estimatedDailyCapacityUnits` using:
   - per-cycle `usage_units / cycle_duration_days`
   - `p50` across valid cycles
   - minimum 2 valid cycles before non-null
5. Implement `utilizationRate24h` as:
   - trailing 24h credential-attributed `usage_units`
   - divided by `estimatedDailyCapacityUnits`
   - return `null` if denominator is `null` or `0`
   - do not cap at `1`
6. Keep health source semantics locked:
   - do not source-slice the derived health fields
   - do not mix source-filtered derived fields with global point-in-time credential state
7. Keep confidence rules from scope doc:
   - short or empty cycles excluded
   - unresolved credential joins excluded
   - monthly contribution counters are not the capacity denominator

Definition of done:
- `getTokenHealth()` returns non-null cycle metrics only when confidence rules are satisfied
- `estimatedDailyCapacityUnits` is not derived from monthly contribution limits
- `utilizationRate24h` is real, capacity-based, and can exceed `1`
- token-event metadata is richer for debugging/validation

## Agent 2 — Aggregate Confidence Checks

Owner:
- anomaly query implementation
- aggregate freshness and mismatch semantics

Primary files:
- `api/src/repos/analyticsRepository.ts`
- `api/src/repos/aggregatesRepository.ts` if helper SQL becomes useful
- optional migration/index file if query support is needed

Tasks:
1. Implement `staleAggregateWindows` using:
   - `in_daily_aggregates.updated_at`
   - raw `in_usage_ledger` windows
   - freshness SLA from the scope doc
2. Implement `usageLedgerVsAggregateMismatchCount` by comparing:
   - raw grouped usage windows from `in_usage_ledger`
   - aggregate windows from `in_daily_aggregates`
3. Lock mismatch semantics:
   - raw rows limited to `entry_type = 'usage'`
   - closed UTC days only
   - compare `requests_count`, `usage_units`, `retail_equivalent_minor`
4. Lock filter semantics:
   - provider filter may apply
   - `source` must be ignored for these aggregate checks
5. Add the smallest query/index support needed if prod-like performance is bad

Definition of done:
- anomaly endpoint returns real non-null values for stale/mismatch checks
- aggregate checks do not incorrectly apply source slicing
- exact mismatch checks exclude the current UTC day

## Agent 3 — Validation + Docs + Test Gate

Owner:
- regression coverage
- contract/doc alignment
- validation SQL/doc updates
- final gate

Primary files:
- `api/tests/analyticsRepository.test.ts`
- `api/tests/analytics.route.test.ts`
- optional new analytics fixture tests
- `docs/API_CONTRACT.md`
- `docs/ANALYTICS.md`
- `docs/ANALYTICS_VALIDATION.md`
- `api/src/routes/analytics.ts` if normalization needs to change

Tasks:
1. Add repository tests for cycle analytics:
   - one maxed cycle
   - multiple maxed/reactivated cycles
   - no-recovery-yet cycle
   - insufficient-evidence nullability
2. Add repository tests for utilization:
   - denominator null -> utilization null
   - value greater than `1` remains greater than `1`
3. Add repository tests for anomaly checks:
   - stale window detected
   - mismatch detected
   - current-day mismatch excluded
   - `source` ignored for aggregate checks
4. Add route tests for final response shapes:
   - health fields non-null when backed by evidence
   - health fields still null when evidence is thin
   - anomaly `ok` reacts correctly to implemented checks
5. Update docs to match shipped behavior:
   - when each health field becomes non-null
   - that `source` remains accepted but non-operative for health derived metrics
   - that aggregate anomaly checks ignore `source`
6. Verify route normalization passes through:
   - non-null derived health values
   - `null` when evidence is still insufficient
7. Keep public contract narrow:
   - do not add optional helper fields like `utilizationState` or `capacityConfidence` in this pass unless explicitly approved later
8. Update validation doc SQL examples to match the final shipped formulas
9. Run final gate:
   - `cd api && npm test`
   - `cd api && npm run build`

Definition of done:
- repository and route regressions cover the new semantics
- contract/docs match the implemented health and anomaly behavior
- validation docs match the final formulas
- full gate is green

## Recommended Execution Order

```
Agent 1 (cycle model + health/utilization metrics)
Agent 2 (aggregate confidence checks) ──→ runs in parallel with Agent 1
Agent 3 (validation + docs + full gate) ──→ runs after 1/2 settle
```

Why:
- utilization depends on the cycle model, so splitting them would create unnecessary coordination
- aggregate anomaly work is mostly independent and should run in parallel
- validation/docs should write final assertions only after formulas stabilize

## Merge Gate

All agents together must satisfy:

```bash
cd api && npm test
cd api && npm run build
```

Additionally:
- no health metric uses monthly contribution limits as a fake capacity denominator
- `utilizationRate24h` is capacity-based and can exceed `1`
- `staleAggregateWindows` and `usageLedgerVsAggregateMismatchCount` are real, non-null checks
- aggregate anomaly checks ignore `source`
- docs match the implemented semantics exactly

## Not In Scope For This Split

- translation-overhead analytics
- source-sliced health metrics
- new public helper fields like `utilizationState` / `capacityConfidence`
- a new snapshot table unless raw-query performance proves unacceptable
