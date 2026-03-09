# Phase 1 Analytics Audit — All Agents

Audited against:
- `docs/planning/PHASE1_ANALYTICS_AGENT_SPLIT.md`
- `docs/planning/PHASE1_ANALYTICS_SCOPE.md`

Updated:
- 2026-03-09 final triage pass — kill/defer/keep decisions applied

## Current Status

- Agent 2 route/contract layer is landed and builds.
- Agent 1 + Agent 3 work has correctness issues that block merge.
- Focused gate is red:
  - `cd api && npm run build` -> pass
  - `cd api && npm test` -> fail
  - failing tests:
    - `tests/tokenCredentialRepository.test.ts`
    - `tests/proxy.tokenMode.route.test.ts`

## Triage Decisions

### Safe To Kill

No scope doc changes needed:

1. **`cli/package.json` version bump.** Unrelated scope drift. Drop from this change.
2. **Code organization / file splitting.** `analytics.ts` (~663 LOC) and `analyticsRepository.ts` (~631 LOC) are large but correct. Not a Phase 1 blocker.
3. **Request-log silent error swallowing.** `.catch(() => {})` on inserts is acceptable for fire-and-forget analytics writes.

### Kill After Descoping In Docs

These are currently locked as requirements in the scope/split docs. They can be cut, but the contract must be lowered first — otherwise the docs say "required" while the code says "not implemented."

1. **`REQUEST_LOG_STORE_FULL` env flag wiring.**
   - Currently locked at `PHASE1_ANALYTICS_AGENT_SPLIT.md:47` ("full content off by env flag").
   - Preview-only is the correct Phase 1 default. The env flag can be wired when someone needs full content.
   - **Action:** remove from split doc required list, mark as future enhancement in scope doc.

2. **`translationOverhead` real query.**
   - Currently required at `PHASE1_ANALYTICS_SCOPE.md:532` and `PHASE1_ANALYTICS_AGENT_SPLIT.md:112`.
   - Requires a `translated` flag or equivalent that doesn't exist in the schema yet.
   - **Action:** remove from scope exit criteria and split doc required metrics. Return `null` (not fake numbers). Update API contract examples.

3. **`requestsBeforeMaxedLastWindow`.**
   - Currently a required Phase 1 metric at `PHASE1_ANALYTICS_AGENT_SPLIT.md:46`.
   - Requires paired maxed-event analysis against usage windows that doesn't exist yet.
   - **Decision:** formally descope — don't leave as forever-null "required metric." Either implement later or cut entirely.
   - **Action:** remove from split doc required metrics and scope exit criteria. Return `null` in health response.

4. **`staleAggregateWindows` and `usageLedgerVsAggregateMismatchCount` anomaly checks.**
   - Currently required by scope at `PHASE1_ANALYTICS_SCOPE.md:407-408`.
   - Currently shipping hard-coded `0` — worst option because it looks green while unimplemented.
   - **Action:** remove from scope required checks. Return `null` (not `0`). Anomaly `ok` must ignore null checks.

5. **Request-log writes on non-success paths.**
   - Scope says "after request completion" which implies all paths, not just success.
   - Error-path writes add complexity without clear Phase 1 value.
   - **Action:** narrow the request-log write contract in scope doc to "successful upstream responses."

6. **Missing repository/route test coverage.**
   - Split doc focused gate requires analytics repository tests green (`PHASE1_ANALYTICS_AGENT_SPLIT.md:240`).
   - No repo-level analytics tests exist today. This is a deliberate gate weakening.
   - **Action:** note in split doc that repo/route test coverage is deferred to a follow-up pass. Acknowledge this weakens the gate.

**Rule: scope doc changes land BEFORE code returns null. Not the other way around.**

### Must Fix (merge blockers)

These are correctness bugs that will crash at runtime or return wrong data:

1. **Health query references nonexistent columns and wrong event type.**
   - `analyticsRepository.ts` queries `requests_before_event`, `usage_units_before_event`, `recovery_time_ms` — these columns don't exist on `in_token_credential_events`. Migration only creates `metadata jsonb`.
   - Queries `event_type = 'recovered'` but migration CHECK allows `'maxed'`, `'reactivated'`, `'probe_failed'` — no `'recovered'` value exists.
   - Will crash with a SQL error at runtime.
   - **Fix:** rewrite health CTE to use real columns. Fix `'recovered'` → `'reactivated'`.

2. **Health query excludes most tokens.**
   - Starts from `active_tokens` derived from recent routing rows. Idle, never-used, maxed, and revoked tokens disappear.
   - Scope says "all tokens in the pool" (`PHASE1_ANALYTICS_SCOPE.md:145`).
   - **Fix:** base query on `in_token_credentials` (the full pool), then LEFT JOIN routing/event data.

3. **UUID/text join mismatches will crash on Postgres.**
   - `in_token_credentials.id` is `uuid`. `route_decision->>'tokenCredentialId'` extracts as `text`. Joining without cast fails on strict Postgres configs.
   - Affected: `/tokens`, `/tokens/health`, `/tokens/routing`, `/requests`.
   - **Fix:** add explicit casts in all join conditions.

4. **Request counting inflated by retries.**
   - `getSystemSummary()` and `getTimeSeries()` use `count(*)` on routing event rows.
   - Validation contract expects `count(distinct request_id)`.
   - Retries/fallback attempts inflate "requests" on dashboards.
   - **Fix:** change to `count(distinct re.request_id)`.

5. **Fallback metrics use wrong definition.**
   - `fallback_count` and `fallback_rate` derived from `upstream_status >= 500`.
   - Split doc and validation SQL require `provider_selection_reason = 'fallback_provider_selected'`.
   - **Fix:** change to route_decision JSON field check.

6. **Test regressions from token event persistence changes.**
   - `recordFailureAndMaybeMax()` changed return shape — `newlyMaxed` field added but tests expect old shape.
   - `reactivateFromMaxed()` reads `row.org_id` from a fixture that doesn't return rows.
   - Auto-max-on-429 proxy test no longer triggers expected repo call.
   - **Fix:** update test fixtures and assertions. Full suite green is non-negotiable.

7. **`percent_of_total` scale mismatch.**
   - Repository computes as 0–100 percentage.
   - `API_CONTRACT.md` and scope doc show 0–1 ratio (e.g. `0.56`).
   - **Fix:** normalize to 0–1 in the query to match docs.

## What's Already Working

- All 7 analytics repository methods exist and are wired.
- Canonical token identity uses `route_decision->>'tokenCredentialId'`.
- `ttfb_ms` threaded into routing events inserts and streaming proxy writes.
- Request-log repository exists with insert/query/purge.
- Request-log retention job registered and working.
- Durable `in_token_credential_events` table exists for `maxedEvents7d`.
- Runtime wiring includes `analytics` and `requestLog` repos.
- Route layer has all 7 endpoints with zod validation and normalization.
- Source classification utility and tests exist.
- Route auth/validation smoke tests pass.
- Analytics utility tests pass.

## Gate Status After Fixes

| Gate Item | Current | After Fixes |
|---|---|---|
| analytics repository tests green | No | Deferred (gate weakened, noted in docs) |
| analytics route tests green | Partial | Partial (existing pass) |
| request-log route/repository tests green | No | Deferred (gate weakened, noted in docs) |
| endpoint auth/validation checked | Partial | Partial |
| source classification checked | Yes | Yes |
| TTFB persisted and queryable | Yes | Yes |
| raw SQL cross-check completed | No | Deferred |
| Phase 1 required metrics queryable | Partial | Yes (descoped items return null, scope docs updated) |
| no guessed `maxedEvents7d` shipped as exact | Partial | Yes (health query fixed) |
| full test suite green | No | Yes (non-negotiable) |

## Verification Snapshot

```bash
cd api && npm run build          # pass
cd api && npm test               # fail (2 test files)
cd api && npx vitest run tests/analytics.route.test.ts tests/analyticsUtils.test.ts  # pass
```
