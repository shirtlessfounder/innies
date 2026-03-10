# Analytics Page Follow-Up 3-Agent Plan

## Goal
Execute the follow-up work in [ANALYTICS_PAGE_FOLLOWUP_PLAN.md](/Users/dylanvu/innies/docs/planning/ANALYTICS_PAGE_FOLLOWUP_PLAN.md) with three agents working in parallel and minimal file overlap.

This split keeps:
- Agent 1 on UI auth / route hardening
- Agent 2 on UI state + operator UX
- Agent 3 on `api/` correctness, stream metering safety, and regressions

## Scope In
- fix current `api` build break in passthrough-stream follow-up code
- prevent partial-stream metering after downstream disconnects
- protect `/analytics` and `/api/analytics/*` in the Next app
- fix analytics rollups so canonical usage only reads `entry_type = 'usage'`
- fix dashboard token attempts for routing-only rows
- fix stale window-switch behavior in the analytics page
- land remaining UI affordances still in scope:
  - sortable tables
  - buyer label + truncated key
  - buyer `orgLabel` fallback to `orgId`

## Shared Rules
- No browser-side admin key exposure.
- Do not revert other agents' work.
- Keep write scopes disjoint unless explicitly coordinated.
- `api` build must be green before final handoff.
- If one agent needs a file outside their ownership, coordinate first instead of freelancing into another write set.

## Agent 1
## UI Auth + Route Hardening

### Ownership
Agent 1 owns analytics access control in `ui/`.

Primary files:
- [ui/src/app/analytics/page.tsx](/Users/dylanvu/innies/ui/src/app/analytics/page.tsx)
- [ui/src/app/page.tsx](/Users/dylanvu/innies/ui/src/app/page.tsx)
- [ui/src/app/api/analytics/dashboard/route.ts](/Users/dylanvu/innies/ui/src/app/api/analytics/dashboard/route.ts)
- [ui/src/app/api/analytics/timeseries/route.ts](/Users/dylanvu/innies/ui/src/app/api/analytics/timeseries/route.ts)
- new shared guard/helper file in `ui/src/lib/` if needed

### Deliverables
- add explicit auth gating for `/analytics`
- add the same gating for `/api/analytics/dashboard`
- add the same gating for `/api/analytics/timeseries`
- ensure unauthorized requests fail before any upstream admin analytics call
- remove or gate the landing-page link to `/analytics` if it remains public
- document any cookie/header/env assumptions needed by the guard

### Avoid
- do not edit [ui/src/lib/analytics/server.ts](/Users/dylanvu/innies/ui/src/lib/analytics/server.ts) unless the guard cannot be done cleanly without it
- do not take ownership of dashboard rendering or hook behavior

### Done When
- unauthenticated access to the analytics UI bridge is blocked
- unauthorized requests cannot reach the upstream admin bridge through Next
- authorized path still works

## Agent 2
## Analytics UI State + Operator UX

### Ownership
Agent 2 owns analytics page behavior and presentation in `ui/`, excluding auth routes.

Primary files:
- [ui/src/app/analytics/AnalyticsDashboardClient.tsx](/Users/dylanvu/innies/ui/src/app/analytics/AnalyticsDashboardClient.tsx)
- [ui/src/app/analytics/page.module.css](/Users/dylanvu/innies/ui/src/app/analytics/page.module.css)
- [ui/src/hooks/useAnalyticsDashboard.ts](/Users/dylanvu/innies/ui/src/hooks/useAnalyticsDashboard.ts)
- [ui/src/hooks/useAnalyticsSeries.ts](/Users/dylanvu/innies/ui/src/hooks/useAnalyticsSeries.ts)
- [ui/src/lib/analytics/types.ts](/Users/dylanvu/innies/ui/src/lib/analytics/types.ts)
- [ui/src/lib/analytics/server.ts](/Users/dylanvu/innies/ui/src/lib/analytics/server.ts)
- [ui/src/lib/analytics/client.ts](/Users/dylanvu/innies/ui/src/lib/analytics/client.ts) if needed for request-state semantics
- [ui/src/components/analytics/AnalyticsChart.tsx](/Users/dylanvu/innies/ui/src/components/analytics/AnalyticsChart.tsx) only if chart state/render needs adjustment

### Deliverables
- fix stale window-switch behavior:
  - old-window data must not remain mislabeled under the new active tab
  - failed refresh after window switch must not leave prior-window data presented as current
- add sorting state + sort controls for token and buyer tables
- keep the dense terminal-style layout intact
- show buyer label and truncated key together
- show buyer `orgLabel` when present, fall back to `orgId`
- keep chart/table selection behavior coherent after window changes

### Avoid
- do not edit [ui/src/app/api/analytics/dashboard/route.ts](/Users/dylanvu/innies/ui/src/app/api/analytics/dashboard/route.ts)
- do not edit [ui/src/app/api/analytics/timeseries/route.ts](/Users/dylanvu/innies/ui/src/app/api/analytics/timeseries/route.ts)
- do not edit `api/`

### Done When
- window switching is trustworthy
- tables sort from the UI
- buyer rows preserve label + truncated key + org context
- page remains readable on desktop/mobile

## Agent 3
## API Correctness + Stream Safety + Regression Coverage

### Ownership
Agent 3 owns `api/` correctness and regression coverage.

Primary files:
- [api/src/routes/proxy.ts](/Users/dylanvu/innies/api/src/routes/proxy.ts)
- [api/src/utils/openaiSyntheticStream.ts](/Users/dylanvu/innies/api/src/utils/openaiSyntheticStream.ts)
- [api/src/repos/analyticsRepository.ts](/Users/dylanvu/innies/api/src/repos/analyticsRepository.ts)
- [api/src/routes/analytics.ts](/Users/dylanvu/innies/api/src/routes/analytics.ts)
- [api/tests/proxy.tokenMode.route.test.ts](/Users/dylanvu/innies/api/tests/proxy.tokenMode.route.test.ts)
- [api/tests/openaiSyntheticStream.test.ts](/Users/dylanvu/innies/api/tests/openaiSyntheticStream.test.ts)
- [api/tests/analyticsRepository.test.ts](/Users/dylanvu/innies/api/tests/analyticsRepository.test.ts)
- [api/tests/analytics.route.test.ts](/Users/dylanvu/innies/api/tests/analytics.route.test.ts)
- [api/tests/analyticsUtils.test.ts](/Users/dylanvu/innies/api/tests/analyticsUtils.test.ts) if needed

### Deliverables
- fix the current `api` TypeScript build break in passthrough-stream hardening
- ensure downstream disconnects / truncated passthrough streams do not record:
  - usage
  - monthly contribution increments
  - stream/idempotency metadata that implies a complete stream
- fix analytics SQL joins so canonical usage metrics only read `ul.entry_type = 'usage'`
- add regression coverage so correction/reversal rows do not skew token, buyer, summary, or timeseries analytics
- fix dashboard token merge so routing-only rows preserve real attempt counts
- add regression coverage for routing-only token rows in `/v1/admin/analytics/dashboard`

### Avoid
- do not edit `ui/`

### Done When
- `pnpm build` passes in `/Users/dylanvu/innies/api`
- partial or client-aborted streams do not contaminate metering
- analytics totals no longer mix non-usage ledger rows
- dashboard token attempts remain correct even without a usage row

## Merge Order
1. Agent 3: unblock `api` build and partial-stream accounting first.
2. Agent 1: land analytics auth gating.
3. Agent 3: land analytics repository / dashboard correctness fixes.
4. Agent 2: land stale-window fix and table/buyer-row UX.
5. Final verification pass across `api` and `ui`.

## No-Overlap Rules
- Agent 1 owns only analytics auth/routing in `ui/`.
- Agent 2 owns analytics dashboard rendering, hooks, and UI analytics types/bridge behavior.
- Agent 3 owns only `api/`.
- If Agent 2 needs a new field from upstream and it already exists in the admin response, Agent 2 should thread it through `ui/` without involving Agent 3.
- If Agent 2 discovers the admin response itself is missing a required field, stop and hand that change to Agent 3 rather than editing `api/`.

## Verification

### Agent 1
- unauthorized request to `/api/analytics/dashboard` fails
- unauthorized request to `/api/analytics/timeseries` fails
- unauthorized visit to `/analytics` is blocked or redirected

### Agent 2
- switch `24h -> 1m -> 24h` and confirm prior-window totals are not shown as current
- force a failed refresh after a window switch and confirm stale data is not mislabeled
- token table sorts correctly by usage and attempts
- buyer table sorts correctly by usage and requests
- buyer rows show label + truncated key + org label fallback

### Agent 3
- `cd /Users/dylanvu/innies/api && pnpm build`
- `cd /Users/dylanvu/innies/api && pnpm test -- proxy.tokenMode.route.test.ts openaiSyntheticStream.test.ts analytics.route.test.ts analyticsRepository.test.ts analyticsUtils.test.ts`

### Final Pass
- `cd /Users/dylanvu/innies/ui && pnpm build`
- authorized analytics UI still loads with live data
- no regressions in the chart/live-table path after the hook/state changes

## Success State
- repo builds again
- analytics bridge is not anonymously exposed
- analytics totals are trustworthy
- partial streams do not leak into metering
- dashboard window switches are trustworthy
- remaining operator-table UX gaps are closed
