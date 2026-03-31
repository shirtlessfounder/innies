# Admin Analytics Content Feeds Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the admin analytics surface with safe-preview request pagination plus new `daily-trends`, `cap-history`, and `sessions` feeds.

**Architecture:** Keep the existing analytics architecture intact: thin Express route handlers in `api/src/routes/analytics.ts`, SQL-first derivation in `api/src/repos/analyticsRepository.ts`, and normalized response shaping in the route layer. Extend the existing `requests` endpoint rather than replacing it, add three new read-only endpoints, and avoid new storage, caching, or archive reads.

**Tech Stack:** TypeScript, Express, Postgres repository queries, Vitest, npm build

---

## File Map

### Modify

- `api/src/routes/analytics.ts`
- `api/src/repos/analyticsRepository.ts`
- `api/tests/analytics.route.test.ts`
- `api/tests/analyticsRepository.test.ts`
- `docs/ANALYTICS.md`

### Check for compile/type fallout

- `api/src/routes/orgAnalytics.ts`
- `api/src/services/analytics/dashboardSnapshot.ts`
- `api/tests/org.route.test.ts`

These are not expected to change behaviorally, but extending `AnalyticsRouteRepository` can require helper/mock updates.

## Chunk 1: Expand Request Drilldown Into A Paginated Safe-Preview Feed

### Task 1: Add failing route tests for paginated request drilldown

**Files:**
- Modify: `api/tests/analytics.route.test.ts`
- Modify: `api/src/routes/analytics.ts`

- [ ] **Step 1: Write the failing request-route tests**

Add tests that assert:
- `GET /v1/admin/analytics/requests` accepts a `cursor`
- invalid request cursors return `400`
- the route passes `cursor` through to the repository query
- the response includes `nextCursor`
- request rows normalize preview fields as `promptPreview` and `responsePreview`

- [ ] **Step 2: Run the targeted request-route tests**

Run:
```bash
cd api && npm test -- analytics.route.test.ts
```

Expected: FAIL on missing cursor validation/response handling or old preview field names

- [ ] **Step 3: Add route-query parsing and normalization for paginated requests**

Implement in `api/src/routes/analytics.ts`:
- a cursor schema for request pagination
- request-query parsing that includes `cursor`
- request-row normalization that emits:
  - `promptPreview`
  - `responsePreview`
  instead of the current `prompt` / `response` aliases
- route response payload with:
  - `window`
  - `limit`
  - `requests`
  - `nextCursor`

- [ ] **Step 4: Re-run the request-route tests**

Run:
```bash
cd api && npm test -- analytics.route.test.ts
```

Expected: PASS for request-route coverage

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/analytics.ts api/tests/analytics.route.test.ts
git commit -m "feat: paginate admin analytics requests"
```

### Task 2: Add failing repository tests for paginated request queries

**Files:**
- Modify: `api/tests/analyticsRepository.test.ts`
- Modify: `api/src/repos/analyticsRepository.ts`

- [ ] **Step 1: Write the failing repository tests**

Add tests that assert:
- `getRecentRequests(...)` orders by `created_at desc, request_id desc, attempt_no desc`
- a provided cursor adds the correct descending pagination predicate
- the query still joins:
  - `in_usage_ledger`
  - `in_request_log`
  - `in_token_credentials`
- the usage join remains constrained to `ul.entry_type = 'usage'`
- the method returns both `requests` and `nextCursor` instead of a bare row array

- [ ] **Step 2: Run the targeted repository tests**

Run:
```bash
cd api && npm test -- analyticsRepository.test.ts
```

Expected: FAIL on old return shape and missing cursor predicate

- [ ] **Step 3: Implement paginated request-query support in the repository**

Implement in `api/src/repos/analyticsRepository.ts`:
- a request-cursor type
- stable ordering and descending pagination filter
- a bounded `limit + 1` fetch pattern or equivalent to detect the next page
- a repository return shape containing:
  - `requests`
  - `nextCursor`

Keep existing request fields and safe-preview joins intact.

- [ ] **Step 4: Re-run the request repository tests**

Run:
```bash
cd api && npm test -- analyticsRepository.test.ts
```

Expected: PASS for request pagination coverage

- [ ] **Step 5: Commit**

```bash
git add api/src/repos/analyticsRepository.ts api/tests/analyticsRepository.test.ts
git commit -m "feat: add request cursor pagination to analytics repository"
```

## Chunk 2: Add Daily Trends And Cap History Feeds

### Task 3: Add failing route tests and query schemas for `daily-trends` and `cap-history`

**Files:**
- Modify: `api/tests/analytics.route.test.ts`
- Modify: `api/src/routes/analytics.ts`

- [ ] **Step 1: Write the failing route tests**

Add tests that assert:
- `GET /v1/admin/analytics/daily-trends` exists and validates:
  - `window`
  - `provider`
  - `source`
  - `orgId`
- `GET /v1/admin/analytics/cap-history` exists and validates:
  - `window`
  - `provider`
  - `orgId`
  - `credentialId`
  - `limit`
  - `cursor`
- both routes call the corresponding repository methods
- both responses expose normalized payload keys:
  - `days`
  - `cycles`
  - `nextCursor` for `cap-history`

- [ ] **Step 2: Run the targeted route tests**

Run:
```bash
cd api && npm test -- analytics.route.test.ts
```

Expected: FAIL with missing route handlers or missing repository methods

- [ ] **Step 3: Add route-layer contracts**

Implement in `api/src/routes/analytics.ts`:
- new filter types for:
  - `DailyTrendsFilters`
  - `CapHistoryFilters`
- new query schemas and defaults
- interface additions on `AnalyticsRouteRepository`
- `missingAnalyticsRepository` stubs for the new methods
- new route registrations for:
  - `/v1/admin/analytics/daily-trends`
  - `/v1/admin/analytics/cap-history`
- normalization helpers for:
  - daily trend rows
  - cap-history rows and cursors

- [ ] **Step 4: Re-run the route tests**

Run:
```bash
cd api && npm test -- analytics.route.test.ts
```

Expected: PASS for the new route coverage

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/analytics.ts api/tests/analytics.route.test.ts
git commit -m "feat: add analytics route contracts for trends and cap history"
```

### Task 4: Add failing repository tests and SQL for `daily-trends`

**Files:**
- Modify: `api/tests/analyticsRepository.test.ts`
- Modify: `api/src/repos/analyticsRepository.ts`

- [ ] **Step 1: Write the failing repository tests**

Add tests that assert:
- `getDailyTrends(...)` buckets by UTC day
- the query reads from `in_routing_events` and `in_usage_ledger`
- the usage join remains limited to canonical `entry_type = 'usage'`
- provider filters apply directly to `re.provider`
- source filters apply through the existing derived `SOURCE_CASE`
- the SQL includes day-series backfilling or equivalent zero-day handling

- [ ] **Step 2: Run the targeted repository tests**

Run:
```bash
cd api && npm test -- analyticsRepository.test.ts
```

Expected: FAIL with missing method or missing SQL shape

- [ ] **Step 3: Implement the minimal daily-trends query**

Implement in `api/src/repos/analyticsRepository.ts`:
- `getDailyTrends(...)`
- UTC day bucketing over raw routing/usage tables
- aggregate fields:
  - `requests`
  - `attempts`
  - `usageUnits`
  - `inputTokens`
  - `outputTokens`
  - `errorRate`
  - `avgLatencyMs`
- per-day `providerSplit`
- per-day `sourceSplit`
- bounded window semantics matching the route defaults

Do not introduce `in_daily_aggregates` as the primary source in v1.

- [ ] **Step 4: Re-run the daily-trends repository tests**

Run:
```bash
cd api && npm test -- analyticsRepository.test.ts
```

Expected: PASS for `daily-trends`

- [ ] **Step 5: Commit**

```bash
git add api/src/repos/analyticsRepository.ts api/tests/analyticsRepository.test.ts
git commit -m "feat: add daily trends analytics query"
```

### Task 5: Add failing repository tests and SQL for `cap-history`

**Files:**
- Modify: `api/tests/analyticsRepository.test.ts`
- Modify: `api/src/repos/analyticsRepository.ts`

- [ ] **Step 1: Write the failing cap-history tests**

Add tests that assert:
- `getCapHistory(...)` reads from `in_token_credential_events`
- exhaustion rows are paired with the next matching clear row by:
  - `token_credential_id`
  - contribution-cap window metadata
- `usageUnitsBeforeCap` and `requestsBeforeCap` are computed from routing/usage data between:
  - the prior clear
  - or the beginning of the requested analytics window
  - and the exhaustion timestamp
- open cycles return:
  - `clearedAt = null`
  - `recoveryMinutes = null`
- provider filtering uses canonical credential-provider semantics so `openai` includes `codex`

- [ ] **Step 2: Run the targeted cap-history tests**

Run:
```bash
cd api && npm test -- analyticsRepository.test.ts
```

Expected: FAIL with missing method or missing event-pairing logic

- [ ] **Step 3: Implement the minimal cap-history query**

Implement in `api/src/repos/analyticsRepository.ts`:
- `getCapHistory(...)`
- event-cycle pairing query or CTE pipeline
- pagination cursor support
- usage/request accumulation between the prior clear/window start and the exhaust event
- credential label joins from `in_token_credentials`

- [ ] **Step 4: Re-run the cap-history repository tests**

Run:
```bash
cd api && npm test -- analyticsRepository.test.ts
```

Expected: PASS for `cap-history`

- [ ] **Step 5: Commit**

```bash
git add api/src/repos/analyticsRepository.ts api/tests/analyticsRepository.test.ts
git commit -m "feat: add token cap history analytics query"
```

## Chunk 3: Add Hybrid Session Analytics And Finish Docs

### Task 6: Add failing route tests and query schema for `sessions`

**Files:**
- Modify: `api/tests/analytics.route.test.ts`
- Modify: `api/src/routes/analytics.ts`

- [ ] **Step 1: Write the failing sessions-route tests**

Add tests that assert:
- `GET /v1/admin/analytics/sessions` exists
- it validates:
  - `window`
  - `provider`
  - `source`
  - `orgId`
  - `limit`
  - `cursor`
  - `idleMinutes`
- it forwards the parsed filters to the repository
- the response includes:
  - `sessions`
  - `nextCursor`
  - `idleMinutes`

- [ ] **Step 2: Run the targeted route tests**

Run:
```bash
cd api && npm test -- analytics.route.test.ts
```

Expected: FAIL with missing sessions route

- [ ] **Step 3: Add the sessions route contract**

Implement in `api/src/routes/analytics.ts`:
- `SessionFilters` type
- sessions query schema and defaults
- repository interface addition
- response normalization for:
  - `sessionKey`
  - `groupingBasis`
  - `startedAt`
  - `endedAt`
  - `durationMinutes`
  - `requestCount`
  - `attemptCount`
  - `usageUnits`
  - `inputTokens`
  - `outputTokens`
  - `providers`
  - `models`
  - `credentialIds`
  - `providerSwitchCount`
  - `samplePromptPreviews`
  - `sampleResponsePreviews`

- [ ] **Step 4: Re-run the sessions-route tests**

Run:
```bash
cd api && npm test -- analytics.route.test.ts
```

Expected: PASS for route coverage

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/analytics.ts api/tests/analytics.route.test.ts
git commit -m "feat: add admin analytics sessions route"
```

### Task 7: Add failing repository tests and SQL for hybrid session grouping

**Files:**
- Modify: `api/tests/analyticsRepository.test.ts`
- Modify: `api/src/repos/analyticsRepository.ts`

- [ ] **Step 1: Write the failing sessions repository tests**

Add tests that assert:
- deterministic grouping prefers:
  - `openclaw_session_id`
  - then `openclaw_run_id`
  - then exact `request_id`
- fallback grouping uses an inactivity-gap heuristic
- the fallback partition lane is conservative and includes:
  - `org_id`
  - `api_key_id`
  - derived source
- provider switch count is computed from grouped attempts
- preview samples come from safe `in_request_log` rows only
- cursor pagination orders by `startedAt desc, sessionKey desc`

- [ ] **Step 2: Run the targeted sessions repository tests**

Run:
```bash
cd api && npm test -- analyticsRepository.test.ts
```

Expected: FAIL with missing method or missing grouping SQL

- [ ] **Step 3: Implement the minimal hybrid session query**

Implement in `api/src/repos/analyticsRepository.ts`:
- `getSessions(...)`
- SQL that:
  - derives deterministic grouping keys from `route_decision`
  - falls back to an idle-gap session number for unlinked rows
  - aggregates grouped request/attempt/usage/token metrics
  - computes provider/model/credential inventories
  - samples a small bounded set of prompt/response previews
- pagination cursor support

Expose `groupingBasis` explicitly so callers can distinguish exact from heuristic sessions.

- [ ] **Step 4: Re-run the sessions repository tests**

Run:
```bash
cd api && npm test -- analyticsRepository.test.ts
```

Expected: PASS for session-query coverage

- [ ] **Step 5: Commit**

```bash
git add api/src/repos/analyticsRepository.ts api/tests/analyticsRepository.test.ts
git commit -m "feat: add hybrid analytics sessions query"
```

### Task 8: Update docs, mock helpers, and run verification

**Files:**
- Modify: `docs/ANALYTICS.md`
- Modify: `api/tests/analytics.route.test.ts`
- Modify: `api/tests/org.route.test.ts`
- Check: `api/src/routes/orgAnalytics.ts`
- Check: `api/src/services/analytics/dashboardSnapshot.ts`

- [ ] **Step 1: Write or extend any failing compile-support tests**

Add or update helper objects so:
- `AnalyticsRouteRepository` mocks in route tests include the new methods
- any type-checked analytics helper usage still compiles after the interface grows

- [ ] **Step 2: Run the full targeted verification set**

Run:
```bash
cd api && npm test -- analytics.route.test.ts analyticsRepository.test.ts org.route.test.ts
```

Expected: FAIL if any interface consumer or mock is incomplete

- [ ] **Step 3: Update docs and cleanup type fallout**

Implement:
- `docs/ANALYTICS.md` entries for:
  - expanded `/requests`
  - `/daily-trends`
  - `/cap-history`
  - `/sessions`
- explicit note that:
  - all four remain safe-preview only
  - `sessions` is heuristic
  - `cap-history` can include open cycles
- any needed mock/helper updates caused by the expanded repository interface

- [ ] **Step 4: Re-run targeted tests and build**

Run:
```bash
cd api && npm test -- analytics.route.test.ts analyticsRepository.test.ts org.route.test.ts
cd api && npm run build
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/ANALYTICS.md api/tests/analytics.route.test.ts api/tests/org.route.test.ts api/src/routes/analytics.ts api/src/repos/analyticsRepository.ts
git commit -m "docs: document admin analytics content feeds"
```

## Final Verification

- [ ] **Step 1: Run the complete analytics verification set**

Run:
```bash
cd api && npm test -- analytics.route.test.ts analyticsRepository.test.ts org.route.test.ts
cd api && npm run build
```

Expected: PASS

- [ ] **Step 2: Review the final diff**

Run:
```bash
git --no-pager diff --stat HEAD~4..HEAD
git --no-pager diff --color=never HEAD~4..HEAD -- api/src/routes/analytics.ts api/src/repos/analyticsRepository.ts api/tests/analytics.route.test.ts api/tests/analyticsRepository.test.ts docs/ANALYTICS.md
```

Expected:
- route changes stay localized to analytics
- repository changes stay inside analytics SQL seams
- no archive/full-content reads were introduced

- [ ] **Step 3: Prepare execution handoff**

Confirm before implementation:
- `requests` remains safe-preview only
- `daily-trends` reads raw routing/usage tables in v1
- `cap-history` returns open cycles
- `sessions` exposes `groupingBasis`
