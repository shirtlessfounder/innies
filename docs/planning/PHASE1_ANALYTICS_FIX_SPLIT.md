# Phase 1 Analytics Fix Split — 3 Agents

Source: `docs/planning/PHASE1_ANALYTICS_AUDIT.md` (triage pass)

Goal: land the must-fix merge blockers so Phase 1 feature `3` analytics can ship.

Rule: **do not silently fake.** Fields that are not implemented must either be removed from the contract or return `null`. Shipping hard-coded `0` that looks green while unimplemented is the worst option. Scope doc changes land BEFORE code returns `null`.

## Agent 2 — Descope + Contract Alignment (runs first)

Owner: scope/contract docs. This agent's work is a prerequisite for Agent 1's deferred-field changes.

### Why Agent 2 goes first

Agent 1 needs to return `null` for descoped fields. That's only valid after the scope/split docs no longer list them as required. If Agent 1 ships `null` while the docs still say "required Phase 1 metric," we have a silent contract violation.

### Tasks

1. **Descope in `docs/planning/PHASE1_ANALYTICS_SCOPE.md`.**
   - Add a "Descoped to Post-Merge" section listing:
     - `translationOverhead` — requires `translated` flag not yet in schema. Returns `null`. (Currently required at line 532.)
     - `requestsBeforeMaxedLastWindow` — requires paired maxed-event analysis. Returns `null`. Formally descoped, not forever-null. (Currently required at line 523.)
     - `staleAggregateWindows` — anomaly check not yet built. Returns `null`. (Currently in example at line 407.)
     - `usageLedgerVsAggregateMismatchCount` — anomaly check not yet built. Returns `null`. (Currently in example at line 408.)
     - `REQUEST_LOG_STORE_FULL` env flag — preview-only is Phase 1 default; full content wiring deferred. (Currently required at line 368.)
   - Update example JSON blocks:
     - `/system`: `"translationOverhead": null`
     - `/tokens/health`: `"requestsBeforeMaxedLastWindow": null`
     - `/anomalies`: `"staleAggregateWindows": null`, `"usageLedgerVsAggregateMismatchCount": null`
   - Narrow request-log write contract to "successful upstream responses" (currently says "after request completion").
   - Update Exit Criteria to remove descoped items.

2. **Descope in `docs/planning/PHASE1_ANALYTICS_AGENT_SPLIT.md`.**
   - Add "Descoped Items" section.
   - Remove `requestsBeforeMaxedLastWindow` from required Phase 1 metrics list (line 46).
   - Remove `translation-overhead split` from Agent 1 task 5 (line 112).
   - Remove `full content off by env flag` from request-log contract (line 47-49).
   - Update Focused Gate (line 240+): note that repo/route test coverage is deferred to follow-up. Acknowledge this weakens the gate.

3. **Update `docs/API_CONTRACT.md` — align with actual implementation.**
   - `translationOverhead` examples must show `null`.
   - `requestsBeforeMaxedLastWindow` must show `null`.
   - Anomaly checks: `staleAggregateWindows` and `usageLedgerVsAggregateMismatchCount` show `null`.
   - `percentOfTotal` must document 0–1 ratio (matching existing doc examples).
   - `REQUEST_LOG_STORE_FULL` must say "not yet wired" rather than implying it works.

4. **Update `docs/ANALYTICS_VALIDATION.md` — align SQL expectations with reality.**
   - Fallback SQL must use `provider_selection_reason = 'fallback_provider_selected'`, not `upstream_status >= 500`.
   - Request count SQL must use `count(distinct request_id)`.
   - Mark descoped checks as "pending implementation."

5. **Verify route layer handles `null` for descoped fields.**
   - Check `api/src/routes/analytics.ts` normalization for `translationOverhead`, `requestsBeforeMaxedLastWindow`, `staleAggregateWindows`, `usageLedgerVsAggregateMismatchCount`.
   - If normalization coerces `null` to `0`, fix it to pass `null` through.

### Files to modify

| File | Changes |
|------|---------|
| `docs/planning/PHASE1_ANALYTICS_SCOPE.md` | Task 1 |
| `docs/planning/PHASE1_ANALYTICS_AGENT_SPLIT.md` | Task 2 |
| `docs/API_CONTRACT.md` | Task 3 |
| `docs/ANALYTICS_VALIDATION.md` | Task 4 |
| `api/src/routes/analytics.ts` | Task 5 (if coercion found) |

### Definition of done

- Descoped items are removed from required/exit-criteria in scope and split docs
- No doc claims an unimplemented feature is working
- Example JSON blocks show `null` for descoped fields
- Scope/split/contract/validation docs are internally consistent
- Route normalization passes `null` through for descoped fields

---

## Agent 1 — Repository Query Fixes (runs after Agent 2 docs land)

Owner: `api/src/repos/analyticsRepository.ts`

### Dependency

Agent 2 must land scope doc changes before Agent 1 returns `null` for descoped fields. Agent 1 can start on tasks 1–6 immediately since those are correctness fixes, not descoping.

### Tasks

1. **Fix `/tokens/health` CTE — nonexistent columns and wrong event type.**
   - Remove references to `requests_before_event`, `usage_units_before_event`, `recovery_time_ms` — these columns don't exist on `in_token_credential_events`.
   - The migration only creates `metadata jsonb`. Either extract from `metadata->>'key'` if the write path populates those keys, or set the derived fields (`avgRequestsBeforeMaxed`, `avgUsageUnitsBeforeMaxed`, `avgRecoveryTimeMs`, `estimatedDailyCapacityUnits`, `maxingCyclesObserved`) to `null`.
   - Change `event_type = 'recovered'` → `event_type = 'reactivated'` (the only valid value per migration CHECK constraint).

2. **Fix `/tokens/health` base query — all pool tokens, not just active routing.**
   - Current query starts from `active_tokens` CTE derived from recent `in_routing_events` rows.
   - Must start from `in_token_credentials` (the full pool) and LEFT JOIN routing/event data.
   - Never-used, idle, maxed, and revoked credentials must appear in the response.

3. **Add UUID/text casts on all credential joins.**
   - `in_token_credentials.id` is `uuid`. Extracted `route_decision->>'tokenCredentialId'` is `text`.
   - Add `tc.id::text` or `credential_id::uuid` in every join condition.
   - Affected methods: `getTokenUsage`, `getTokenHealth`, `getTokenRouting`, `getRecentRequests`.
   - Grep for `tc.id =` to find all instances.

4. **Fix request counting — `count(distinct)` not `count(*)`.**
   - `getSystemSummary()`: change `count(*)` to `count(distinct re.request_id)` for request totals.
   - `getTimeSeries()`: same fix.
   - Leave `totalAttempts` in routing as `count(*)` — that's correct for attempt counting.

5. **Fix fallback metrics — routing metadata, not status codes.**
   - `getTokenRouting()`: change `fallback_count` from `upstream_status >= 500` to `route_decision->>'provider_selection_reason' = 'fallback_provider_selected'`.
   - `getSystemSummary()`: same fix for `fallback_rate`.

6. **Fix `percent_of_total` scale.**
   - In `getSystemSummary()` top-buyers query, change from 0–100 to 0–1 ratio to match `API_CONTRACT.md`.
   - `ROUND(... * 100, 1)` → `ROUND(..., 4)` (or equivalent).

7. **Set descoped fields to `null` instead of hard-coded `0`.** (after Agent 2 docs land)
   - `translationOverhead`: return `null` for all 6 sub-fields.
   - `requestsBeforeMaxedLastWindow`: return `null` in health response.
   - `staleAggregateWindows`: return `null` in anomalies response.
   - `usageLedgerVsAggregateMismatchCount`: return `null` in anomalies response.
   - Update the `ok` computation in anomalies to ignore null checks (only fail on non-null non-zero values).

### Files to modify

| File | Changes |
|------|---------|
| `api/src/repos/analyticsRepository.ts` | Tasks 1–7 |

### Definition of done

- `npm run build` passes
- Health query won't crash at runtime (no references to nonexistent columns)
- Health returns all pool tokens
- No UUID/text join mismatches
- Request counts use `count(distinct request_id)`
- Fallback uses routing metadata
- `percent_of_total` is 0–1
- Descoped fields return `null`, not `0`

---

## Agent 3 — Test Regression Fixes (runs in parallel)

Owner: restore green test suite

### Tasks

1. **Fix `tests/tokenCredentialRepository.test.ts`.**
   - `recordFailureAndMaybeMax()` now returns `{ ...row, newlyMaxed: boolean }`. Update test assertions to expect the new shape.
   - `reactivateFromMaxed()` tries to read `row.org_id` from a fixture path that returns no row. Fix the fixture or the assertion to match current repo behavior.
   - Verify all other tests in this file still pass after fixes.

2. **Fix `tests/proxy.tokenMode.route.test.ts`.**
   - Auto-max-on-429 scenario: the proxy path no longer triggers the expected repository call pattern in the test. Investigate the current call sequence and update the test mock/assertion.
   - This may require reading `api/src/routes/proxy.ts` to understand the current maxing trigger path and `api/src/repos/tokenCredentialRepository.ts` to understand the current return shape.

3. **Run full test suite and verify green.**
   - `cd api && npm test` must pass with zero failures.
   - `cd api && npm run build` must pass.
   - **Full suite green is non-negotiable.**

4. **Re-verify after Agent 1 lands.**
   - `cd api && npx vitest run tests/analytics.route.test.ts tests/analyticsUtils.test.ts` must still pass.
   - If Agent 1's changes to `analyticsRepository.ts` break any mocked route tests, update the mocks to match the new return shapes.
   - Re-run `cd api && npm test` for the final gate check.

### Files to modify

| File | Changes |
|------|---------|
| `api/tests/tokenCredentialRepository.test.ts` | Task 1 |
| `api/tests/proxy.tokenMode.route.test.ts` | Task 2 |

### Definition of done

- `cd api && npm test` passes with zero failures
- `cd api && npm run build` passes
- No test is skipped or disabled to achieve green

---

## Execution Order

```
Agent 2 (docs descoping)  ──→  Agent 1 task 7 (null for descoped fields)
                                  ↓
Agent 1 tasks 1–6 (start immediately, no dependency)
                                  ↓
Agent 3 tasks 1–2 (start immediately, pre-existing failures)
                                  ↓
Agent 3 tasks 3–4 (re-verify after Agent 1 lands)
```

- **Agent 2** starts first on doc changes. These are quick and unlock Agent 1 task 7.
- **Agent 1 tasks 1–6** can start immediately (correctness fixes, no doc dependency).
- **Agent 1 task 7** (null for descoped fields) waits for Agent 2 docs to land.
- **Agent 3 tasks 1–2** start immediately — these are pre-existing test regressions.
- **Agent 3 tasks 3–4** run last as the final gate verification after all other changes land.

## Merge Gate

All three agents' work must satisfy:

```bash
cd api && npm run build    # pass
cd api && npm test         # pass (zero failures)
```

Additionally:
- Descoped fields return `null`, not `0`
- Scope/split/contract/validation docs are internally consistent
- No doc claims an unimplemented feature is working
- Full test suite green — non-negotiable
