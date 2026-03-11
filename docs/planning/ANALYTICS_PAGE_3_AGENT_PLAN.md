# Analytics Page 3-Agent Plan

## Goal
Complete the internal `/analytics` page defined in [ANALYTICS_PAGE_SCOPE.md](/Users/dylanvu/innies/docs/planning/ANALYTICS_PAGE_SCOPE.md) with three agents working in parallel.

This plan assumes:
- terminal-style operator UI
- `5h`, `24h`, `1w`, `1m` filters
- live updates via polling in v1
- token credential table
- buyer key table
- historical charts
- anomaly/event/operator extras

## Frozen Decisions Before Work Starts
- Token table should use `Attempts`, not `Requests`, unless Agent 1 expands backend semantics.
- Summary strip can keep existing system-level `Requests`.
- `Maxed 7d`, `Auth Failures 24h`, and `Rate Limits 24h` stay labeled as fixed-window metrics.
- Client must not receive an admin API key.
- UI should fetch through same-origin server routes or server components.
- `lightweight-charts` is the chart library.
- Safe key display can ship in v1 with short UUID-derived fallback display ids if true display fingerprints are not ready.

## Shared Contract Checkpoint
Before anyone starts coding, align on this exact response shape:

### Dashboard Snapshot
Recommended primary payload:
- `window`
- `snapshotAt`
- `summary`
- `tokens`
- `buyers`
- `anomalies`
- `events`

### Token Row
- `credentialId`
- `displayKey`
- `debugLabel`
- `provider`
- `status`
- `attempts`
- `usageUnits`
- `percentOfWindow`
- `utilizationRate24h`
- `maxedEvents7d`
- `monthlyContributionUsedUnits`
- `monthlyContributionLimitUnits`
- `latencyP50Ms`
- `authFailures24h`
- `rateLimited24h`

### Buyer Row
- `apiKeyId`
- `displayKey`
- `label`
- `orgId`
- `preferredProvider`
- `effectiveProvider`
- `requests`
- `usageUnits`
- `percentOfWindow`
- `lastSeenAt`
- `errorRate`

### Event Row
- `id`
- `type`
- `createdAt`
- `provider`
- `credentialId`
- `credentialLabel`
- `summary`
- `severity`
- `metadata`

## Agent 1
## Backend Analytics Contract + Queries

### Ownership
Agent 1 owns `api/`.

Primary files:
- [api/src/routes/analytics.ts](/Users/dylanvu/innies/api/src/routes/analytics.ts)
- [api/src/repos/analyticsRepository.ts](/Users/dylanvu/innies/api/src/repos/analyticsRepository.ts)
- [api/src/utils/analytics.ts](/Users/dylanvu/innies/api/src/utils/analytics.ts)
- [api/src/repos/apiKeyRepository.ts](/Users/dylanvu/innies/api/src/repos/apiKeyRepository.ts) if needed for buyer inventory joins
- [api/tests/analytics.route.test.ts](/Users/dylanvu/innies/api/tests/analytics.route.test.ts)
- [api/tests/analyticsRepository.test.ts](/Users/dylanvu/innies/api/tests/analyticsRepository.test.ts)
- [api/tests/analyticsRepository.anomalies.test.ts](/Users/dylanvu/innies/api/tests/analyticsRepository.anomalies.test.ts)

### Deliverables
- Add `5h` analytics window support.
- Add finer timeseries granularity:
  - `5m` for `5h`
  - `15m` for `24h` if cheap
- Add buyer analytics endpoints:
  - `GET /v1/admin/analytics/buyers`
  - `GET /v1/admin/analytics/buyers/timeseries`
- Add lifecycle event read endpoint:
  - `GET /v1/admin/analytics/events`
- Strongly recommended:
  - add `GET /v1/admin/analytics/dashboard`
  - one snapshot response for summary + tokens + buyers + anomalies + events
- Add `attemptNo` to `GET /v1/admin/analytics/requests`
- Make buyer inventory query return all buyer keys with scope `buyer_proxy`, including zero-usage rows.
- Return safe display fallback for keys:
  - short UUID-style fallback is acceptable in v1

### Required Semantic Fixes
- Be explicit about `attempts` vs `requests`.
- Do not silently rename existing attempt-based token counts to requests.
- Preserve current fixed-window semantics for:
  - `maxedEvents7d`
  - `authFailures24h`
  - `rateLimited24h`

### Handoff To Other Agents
Agent 1 hands off:
- final JSON response examples
- route list and query params
- exact field names
- any fields that are nullable or best-effort

### Done When
- backend routes are implemented
- route and repository tests are green
- Agent 3 can integrate against stable response shapes without inventing missing fields

## Agent 2
## Frontend Console UI + Terminal Presentation

### Ownership
Agent 2 owns visual components and styling in `ui/`.

Primary files:
- [ui/package.json](/Users/dylanvu/innies/ui/package.json)
- [ui/src/app/analytics/page.module.css](/Users/dylanvu/innies/ui/src/app/analytics/page.module.css)
- `ui/src/components/analytics/AnalyticsConsole.tsx`
- `ui/src/components/analytics/WindowTabs.tsx`
- `ui/src/components/analytics/SummaryStrip.tsx`
- `ui/src/components/analytics/EntityUsageTable.tsx`
- `ui/src/components/analytics/UsageDeltaCell.tsx`
- `ui/src/components/analytics/AnalyticsChart.tsx`
- `ui/src/components/analytics/EventRail.tsx`
- `ui/src/components/analytics/AnomalyStrip.tsx`

### Deliverables
- Build the terminal-style page shell and panel system.
- Build compact segmented window filters.
- Build summary strip UI.
- Build token and buyer tables:
  - sortable
  - selectable
  - dense tabular layout
  - right-aligned numerics
- Build cell flash treatment for live increments.
- Build chart panel with row-toggle affordances.
- Build event rail and anomaly strip.
- Make the page usable on mobile without collapsing into a giant card stack.
- Add `lightweight-charts` dependency and own chart component rendering.

### Constraints
- Agent 2 should build presentational components that accept typed props.
- Agent 2 should not own server fetch logic, admin-key handling, or API route integration.
- Agent 2 should avoid editing `ui/src/app/analytics/page.tsx` except by agreement with Agent 3.

### Handoff To Other Agents
Agent 2 hands off:
- presentational component API
- prop types for summary/tables/chart/events
- CSS modules and visual states
- selected-row and sort UI contracts

### Done When
- the page looks and behaves like an operator console
- components are wired for loading, empty, and error visuals
- Agent 3 can drop real data into the components without rewriting the UI

## Agent 3
## UI Data Layer + Server Bridge + Live Integration

### Ownership
Agent 3 owns data orchestration in `ui/`.

Primary files:
- [ui/src/app/analytics/page.tsx](/Users/dylanvu/innies/ui/src/app/analytics/page.tsx)
- `ui/src/app/api/analytics/dashboard/route.ts`
- `ui/src/app/api/analytics/timeseries/route.ts`
- `ui/src/lib/analytics/types.ts`
- `ui/src/lib/analytics/server.ts`
- `ui/src/lib/analytics/client.ts`
- `ui/src/hooks/useAnalyticsDashboard.ts`
- `ui/src/hooks/useAnalyticsSeries.ts`

### Deliverables
- Create same-origin server-backed fetch path from the Next UI to Innies admin analytics APIs.
- Define env contract for server-side access, for example:
  - `INNIES_ADMIN_API_BASE_URL`
  - `INNIES_ADMIN_API_KEY`
- Normalize backend payloads into UI-facing types.
- Own the polling loop:
  - live status
  - last successful update time
  - degraded state
  - cycle-based delta computation
- Wire Agent 2 components to real data.
- Handle token chart fan-out if Agent 1 does not provide a multi-entity chart endpoint.
- Keep selected-series count capped.
- Own loading, empty, retry, and partial-failure behavior.
- Add manual verification notes or a small operator checklist if no frontend test harness exists.

### Constraints
- Agent 3 should not redesign visuals owned by Agent 2.
- Agent 3 should not change backend contract owned by Agent 1 except through agreed contract fixes.

### Handoff To Other Agents
Agent 3 hands off:
- integrated page
- server route contract
- env requirements
- live update behavior
- manual verification results

### Done When
- `/analytics` renders real live data through same-origin server-backed paths
- browser never sees admin credentials
- delta flash only triggers on successful full-cycle updates
- chart selection and polling are stable

## Parallelization Plan

### Start Immediately
- Agent 1 starts backend contract work.
- Agent 2 starts presentational UI from the frozen response shapes.
- Agent 3 starts server-bridge scaffolding, UI types, and polling shell.

### Midpoint Contract Check
When Agent 1 has draft response shapes:
- freeze field names
- freeze nullability
- freeze `attempts` vs `requests`
- freeze window and granularity enums

### Integration Phase
- Agent 3 integrates Agent 1 responses into Agent 2 components.
- Agent 2 handles any minimal prop-shape adjustments.
- Agent 1 fixes backend gaps found during real integration.

## Merge Order
1. Agent 1 backend routes and tests
2. Agent 2 visual components and CSS
3. Agent 3 integration branch
4. final polish pass across all three slices

## No-Overlap Rules
- Agent 1 does not edit `ui/`.
- Agent 2 does not edit `api/`.
- Agent 3 does not edit Agent 2 visual components unless a handoff issue requires it.
- Agent 2 should avoid `page.tsx`.
- Agent 3 should avoid `page.module.css` unless Agent 2 explicitly hands it off.

## Risk List
- Buyer-key analytics is the real blocker; token analytics is mostly already there.
- `5h` is not just a filter label; it requires backend window support and finer granularity.
- Current analytics semantics mix attempts and requests; bad labeling will confuse the page immediately.
- Without a snapshot endpoint, polling multiple endpoints can produce noisy deltas and inconsistent sample times.
- Without safe display fingerprints, "truncated keys" will be weak in v1 and should fall back to short stable ids plus labels.

## Recommended Success Criteria Per Agent

### Agent 1
- all required analytics data exists and is queryable
- tests green

### Agent 2
- UI feels like a terminal console, not a placeholder dashboard
- tables and chart are readable on desktop and mobile

### Agent 3
- page is live, stable, and server-backed
- no page refresh required
- no admin secret leaks to client

## Final Acceptance
The page is done when:
- an operator can open `/analytics`
- switch `5h`, `24h`, `1w`, `1m`
- see live token and buyer-key usage changes
- see increments flash in-place
- toggle rows into a historical chart
- inspect anomaly and lifecycle context
- do all of that without browser-side admin credentials or manual page refresh
