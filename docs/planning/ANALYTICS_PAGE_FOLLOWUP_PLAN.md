# Analytics Page Follow-Up Plan

## Goal
Close the post-merge audit findings on the internal `/analytics` page and harden it for real operator use.

This follow-up is not a redesign pass. Scope is:
- API build integrity for merged follow-up work
- security / access control
- analytics aggregation correctness
- stream metering correctness where analytics trusts routed usage data
- correctness during live window changes
- missing operator affordances already called for in scope
- small contract/UI gaps found during audit

## Audit Findings To Execute

### Blocker A. High: `api` build is currently red in streaming follow-up code
Current risk:
- [api/src/routes/proxy.ts](/Users/dylanvu/innies/api/src/routes/proxy.ts)

Problem:
- the new passthrough-stream hardening path does not type-check
- `downstreamUsesAnthropicSse` is inferred as `boolean | CompatTranslationMeta`
- `pnpm build` in `api/` currently fails on the synthetic terminal-SSE call sites

Impact:
- repo build gate is red
- follow-up fixes cannot be shipped cleanly until this is corrected

Required outcome:
- `api` must compile cleanly again
- normalize the stream-mode flag to a real boolean and keep build verification in scope for this follow-up

### Blocker B. High: downstream disconnect path can meter partial streams
Current risk:
- [api/src/routes/proxy.ts](/Users/dylanvu/innies/api/src/routes/proxy.ts)
- [api/tests/proxy.tokenMode.route.test.ts](/Users/dylanvu/innies/api/tests/proxy.tokenMode.route.test.ts)

Problem:
- the new passthrough-stream truncation logic only marks `streamTruncated` for synthetic failure insertion paths
- when the downstream client disconnects under backpressure, bookkeeping can still commit idempotency metadata, increment monthly contribution usage, and record usage from a partial sample

Impact:
- analytics totals and billing-adjacent usage numbers can drift on aborted streams
- monthly contribution counters can be overstated even though the client never received a complete terminal stream

Required outcome:
- downstream disconnects must not record usage, monthly contribution increments, or stream metadata unless a complete terminal stream was actually observed
- add regression coverage for disconnect/backpressure cases

### 1. High: unauthenticated UI proxy to admin analytics APIs
Current risk:
- [ui/src/app/api/analytics/dashboard/route.ts](/Users/dylanvu/innies/ui/src/app/api/analytics/dashboard/route.ts)
- [ui/src/app/api/analytics/timeseries/route.ts](/Users/dylanvu/innies/ui/src/app/api/analytics/timeseries/route.ts)
- [ui/src/lib/analytics/server.ts](/Users/dylanvu/innies/ui/src/lib/analytics/server.ts)
- [ui/src/app/page.tsx](/Users/dylanvu/innies/ui/src/app/page.tsx)

Problem:
- the Next server routes proxy directly to Innies admin analytics using `INNIES_ADMIN_API_KEY`
- there is no app-layer auth check in the UI route handlers
- the public landing page links directly to `/analytics`

Impact:
- anyone who can hit the UI routes may be able to read internal admin analytics through the server bridge

Required outcome:
- `/analytics` and `/api/analytics/*` must be protected before any upstream admin call is made

### 2. Medium: stale snapshot remains visible during window switches
Current risk:
- [ui/src/hooks/useAnalyticsDashboard.ts](/Users/dylanvu/innies/ui/src/hooks/useAnalyticsDashboard.ts)
- [ui/src/app/analytics/AnalyticsDashboardClient.tsx](/Users/dylanvu/innies/ui/src/app/analytics/AnalyticsDashboardClient.tsx)

Problem:
- when switching `24h -> 1m` or similar, the previous window's snapshot stays rendered until the new fetch completes
- the UI can show the new selected tab while still rendering old-window summary/table data
- if the new fetch fails, the old snapshot can remain on screen under the newly selected tab

Impact:
- misleading operator view
- easy to draw the wrong conclusion from stale numbers

Required outcome:
- window changes must either clear old snapshot UI immediately or mark it clearly as stale/loading for the prior window
- summary, tables, and chart selection state should stay semantically aligned with the active window
- a failed refresh after a window switch must not leave prior-window data mislabeled as current

### 3. Medium: sortable table requirement did not land
Current risk:
- [ui/src/app/analytics/AnalyticsDashboardClient.tsx](/Users/dylanvu/innies/ui/src/app/analytics/AnalyticsDashboardClient.tsx)

Problem:
- token and buyer tables are static renderings with no sort controls
- original scope called for sortable dense operator tables

Impact:
- operators cannot quickly pivot by usage, attempts, requests, provider, or status

Required outcome:
- implement client-side sort controls and default sort behavior for both tables

### 4. Low: buyer org label is dropped in UI bridge
Current risk:
- [api/src/routes/analytics.ts](/Users/dylanvu/innies/api/src/routes/analytics.ts)
- [ui/src/lib/analytics/server.ts](/Users/dylanvu/innies/ui/src/lib/analytics/server.ts)
- [ui/src/lib/analytics/types.ts](/Users/dylanvu/innies/ui/src/lib/analytics/types.ts)
- [ui/src/app/analytics/AnalyticsDashboardClient.tsx](/Users/dylanvu/innies/ui/src/app/analytics/AnalyticsDashboardClient.tsx)

Problem:
- backend now exposes buyer `orgLabel`
- UI bridge/types/table only keep `orgId`

Impact:
- loses the more useful operator-facing org context

Required outcome:
- preserve and display `orgLabel` when present, falling back to `orgId`

### 5. High: analytics rollups count non-usage ledger rows
Current risk:
- [api/src/repos/analyticsRepository.ts](/Users/dylanvu/innies/api/src/repos/analyticsRepository.ts)
- [api/src/repos/usageLedgerRepository.ts](/Users/dylanvu/innies/api/src/repos/usageLedgerRepository.ts)

Problem:
- multiple new analytics queries join `in_usage_ledger` on request identity without restricting `entry_type = 'usage'`
- the ledger now stores `usage`, `correction`, and `reversal` rows
- corrected attempts can therefore be double-counted or negated incorrectly in dashboard rollups

Impact:
- token usage, buyer usage, summary totals, timeseries, and recent-request usage can drift from the real operator numbers
- this is a trust-breaking data bug, not just a display issue

Required outcome:
- every analytics join that intends to show canonical usage must filter `ul.entry_type = 'usage'`
- add regression coverage for token, buyer, summary, and timeseries paths so correction/reversal rows cannot silently skew totals again

### 6. Medium: buyer table hides truncated key when a label exists
Current risk:
- [ui/src/app/analytics/AnalyticsDashboardClient.tsx](/Users/dylanvu/innies/ui/src/app/analytics/AnalyticsDashboardClient.tsx)

Problem:
- buyer rows currently render `label ?? displayKey`
- when a label exists, the truncated buyer key disappears entirely

Impact:
- misses the explicit requirement to show truncated buyer keys with labels
- makes it harder for operators to distinguish similarly named buyer keys

Required outcome:
- buyer rows should show both the human label and the truncated key
- this should stay dense and readable in the existing terminal-style table layout

### 7. Medium: dashboard token attempts undercount routing-only credentials
Current risk:
- [api/src/routes/analytics.ts](/Users/dylanvu/innies/api/src/routes/analytics.ts)
- [api/tests/analytics.route.test.ts](/Users/dylanvu/innies/api/tests/analytics.route.test.ts)

Problem:
- `/v1/admin/analytics/dashboard` merges token usage, health, and routing rows in `mergeDashboardTokens()`
- routing-only rows are initialized with `attempts: 0` and never pick up `totalAttempts`
- tokens with failed or non-usage traffic but no usage row can therefore appear with zero attempts

Impact:
- operator dashboard underreports credential traffic in exactly the cases where routing-only failures matter most

Required outcome:
- dashboard token merge must preserve routing attempt counts even when no usage row exists
- add regression coverage for routing-only token rows in dashboard snapshots

## Execution Defaults
- `api` must build cleanly before this follow-up is considered done
- `/analytics` and `/api/analytics/*` must reject unauthorized requests before any upstream admin call
- canonical analytics usage must read `in_usage_ledger.entry_type = 'usage'`
- downstream-disconnected or truncated streams must not record partial usage
- window changes must clear or clearly stale-mark prior-window data immediately
- buyer rows should show label and truncated key together

## Agent Split

## Agent 1
## UI Auth + Route Hardening

### Ownership
Agent 1 owns security hardening in `ui/`.

Primary files:
- [ui/src/app/analytics/page.tsx](/Users/dylanvu/innies/ui/src/app/analytics/page.tsx)
- [ui/src/app/page.tsx](/Users/dylanvu/innies/ui/src/app/page.tsx)
- [ui/src/app/api/analytics/dashboard/route.ts](/Users/dylanvu/innies/ui/src/app/api/analytics/dashboard/route.ts)
- [ui/src/app/api/analytics/timeseries/route.ts](/Users/dylanvu/innies/ui/src/app/api/analytics/timeseries/route.ts)
- shared auth/guard helper file if needed in `ui/src/lib/`

### Deliverables
- add explicit auth/access gate for `/analytics`
- add the same gate for `/api/analytics/dashboard`
- add the same gate for `/api/analytics/timeseries`
- ensure unauthorized requests fail before any call to the admin bridge
- if necessary, remove or gate the public landing-page link to `/analytics`
- document env/cookie/header requirements if a new internal gate is introduced

Current guard contract:
- Basic Auth on `/analytics` and `/api/analytics/*`
- env:
  - `INNIES_ANALYTICS_BASIC_AUTH_USERNAME`
  - `INNIES_ANALYTICS_BASIC_AUTH_PASSWORD`
  - optional `INNIES_ANALYTICS_BASIC_AUTH_REALM`
  - optional `INNIES_ANALYTICS_SHOW_INDEX_LINK=true|false`

### Done When
- unauthenticated access to the analytics UI bridge is blocked
- admin analytics upstream calls cannot be reached anonymously through the Next app

## Agent 2
## Analytics Console UX Corrections

### Ownership
Agent 2 owns operator-facing UX fixes in the analytics page.

Primary files:
- [ui/src/app/analytics/AnalyticsDashboardClient.tsx](/Users/dylanvu/innies/ui/src/app/analytics/AnalyticsDashboardClient.tsx)
- [ui/src/app/analytics/page.module.css](/Users/dylanvu/innies/ui/src/app/analytics/page.module.css)
- [ui/src/lib/analytics/types.ts](/Users/dylanvu/innies/ui/src/lib/analytics/types.ts)

### Deliverables
- add sorting state + sort controls for token and buyer tables
- add visible sort affordances in headers
- preserve dense operator layout
- show truncated buyer key alongside the buyer label
- show buyer `orgLabel` when present, fall back to `orgId`

### Done When
- both tables are sortable from the UI
- buyer rows no longer lose the truncated key when labels exist
- org label is no longer lost
- the page stays dense and readable on desktop/mobile

## Agent 3
## Data-Layer Correctness + Verification

### Ownership
Agent 3 owns data correctness, state-management correctness, and verification.

Primary files:
- [api/src/repos/analyticsRepository.ts](/Users/dylanvu/innies/api/src/repos/analyticsRepository.ts)
- [api/src/routes/analytics.ts](/Users/dylanvu/innies/api/src/routes/analytics.ts)
- [api/src/routes/proxy.ts](/Users/dylanvu/innies/api/src/routes/proxy.ts)
- [api/src/utils/openaiSyntheticStream.ts](/Users/dylanvu/innies/api/src/utils/openaiSyntheticStream.ts)
- [api/tests/analyticsRepository.test.ts](/Users/dylanvu/innies/api/tests/analyticsRepository.test.ts)
- [api/tests/analytics.route.test.ts](/Users/dylanvu/innies/api/tests/analytics.route.test.ts)
- [api/tests/openaiSyntheticStream.test.ts](/Users/dylanvu/innies/api/tests/openaiSyntheticStream.test.ts)
- [api/tests/proxy.tokenMode.route.test.ts](/Users/dylanvu/innies/api/tests/proxy.tokenMode.route.test.ts)
- [ui/src/hooks/useAnalyticsDashboard.ts](/Users/dylanvu/innies/ui/src/hooks/useAnalyticsDashboard.ts)
- [ui/src/hooks/useAnalyticsSeries.ts](/Users/dylanvu/innies/ui/src/hooks/useAnalyticsSeries.ts)
- [ui/src/lib/analytics/server.ts](/Users/dylanvu/innies/ui/src/lib/analytics/server.ts)
- [ui/src/lib/analytics/types.ts](/Users/dylanvu/innies/ui/src/lib/analytics/types.ts)
- analytics test files if a harness is added

### Deliverables
- fix the current `api` build break in the passthrough-stream hardening path
- ensure downstream disconnects do not record partial usage, monthly contribution increments, or stream idempotency metadata
- add regression coverage for disconnect/backpressure streaming cases
- fix analytics SQL joins so canonical usage metrics only read `entry_type = 'usage'`
- add regression tests for correction/reversal rows not polluting dashboard totals
- fix dashboard token merge so routing-only rows preserve real attempt counts
- add regression coverage for dashboard routing-only token rows
- fix stale-window rendering during window changes
- reset or clearly stale-mark dashboard snapshot + series during window changes
- thread `orgLabel` through the server bridge/types if Agent 2 does not own that exact line
- add API regression coverage for analytics correctness issues fixed in this follow-up
- keep the manual verification checklist in this doc for auth, window-switch, and table UX behavior

### Done When
- `api` TypeScript build is green again
- downstream-disconnected or truncated streams cannot silently meter partial usage
- corrected or reversed ledger rows cannot silently skew analytics usage rollups
- dashboard token attempt counts stay correct even for routing-only rows
- changing the selected window cannot leave prior-window data mislabeled as current
- verification steps exist and were actually run

## Suggested Merge Order
1. Agent 3 `api` build fix + partial-stream accounting fix
2. Agent 1 security hardening
3. Agent 3 analytics query correctness + dashboard merge correctness
4. Agent 3 window-switch correctness
5. Agent 2 sorting + buyer identity + org label UX
6. final verification pass

Reason:
- current `api` build failure is an immediate merge blocker
- partial-stream metering is a trust-breaking data bug and should be fixed before more analytics polish
- security issue is ship-blocking
- analytics query correctness is next-highest risk because bad numbers undermine the whole page
- stale-window correctness is next-highest operator risk after that
- sort / buyer identity / org-label are important but not as dangerous

## No-Overlap Rules
- Agent 1 owns auth gating and any new shared guard helper
- Agent 2 owns analytics page presentation and sort UI
- Agent 3 owns analytics repository correctness, hooks/server bridge correctness, and verification
- if `orgLabel` threading spans both Agent 2 and Agent 3 ownership, Agent 3 owns data propagation and Agent 2 only owns display

## Verification Checklist

### Security
- unauthorized request to `/api/analytics/dashboard` fails
- unauthorized request to `/api/analytics/timeseries` fails
- unauthorized visit to `/analytics` is blocked or redirected
- authorized path still reaches live analytics successfully

### Correctness
- simulate a downstream client disconnect during passthrough streaming and confirm no usage, monthly contribution, or stream metadata is committed
- seed or mock usage + correction + reversal ledger rows for one request and confirm dashboard totals only reflect `usage`
- create a dashboard token that only appears in routing rows and confirm its attempt count is non-zero in `/v1/admin/analytics/dashboard`
- switch `24h -> 1m -> 24h` and confirm no prior-window totals remain visible under the new active tab
- pause/resume polling and confirm deltas only compute from successful full refreshes
- token and buyer selections remain valid after a window change

### UX
- token table sorts correctly by usage and attempts
- buyer table sorts correctly by usage and requests
- buyer rows show truncated keys even when labels exist
- buyer rows show org label when available
- mobile layout remains usable after adding sort controls

### Build / Tests
- `ui`: `pnpm build`
- `api`: `pnpm build`
- `api`: `pnpm test -- proxy.tokenMode.route.test.ts openaiSyntheticStream.test.ts analytics.route.test.ts analyticsRepository.test.ts analyticsUtils.test.ts`
- add and run any new tests that land

## Success Criteria
- `api` build is green and the analytics-related regressions are covered
- analytics data is trustworthy: no anonymous admin bridge access, no partial-stream metering leakage, no correction/reversal rollup skew, no routing-only attempt undercount
- operator UI is trustworthy: window switches are not mislabeled, sortable tables exist if kept in scope, and buyer rows preserve key/org context
