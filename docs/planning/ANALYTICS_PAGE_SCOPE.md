# Analytics Page Scope

## Objective
Ship a real internal `/analytics` page for keys with:
- live, no-refresh updates
- token credential usage visibility
- buyer key usage visibility
- historical charts with row toggles
- a terminal-flavored presentation that fits the existing Innies shell

This page should answer:
- Which token credentials are carrying the pool right now?
- Which buyer keys are consuming the most right now?
- Which keys are heating up, cooling off, maxing, or failing?
- How has usage changed over the last `5h`, `24h`, `1w`, and `1m`?

## Current State (2026-03-10)
- UI route exists but is empty: [ui/src/app/analytics/page.tsx](/Users/dylanvu/innies/ui/src/app/analytics/page.tsx#L1)
- Nearby internal UI pages still use [ui/src/lib/mockAdapters.ts](/Users/dylanvu/innies/ui/src/lib/mockAdapters.ts#L1); there is no established real analytics fetch layer in the UI yet.
- Analytics backend exists for token/system/request/anomaly views:
  - [api/src/routes/analytics.ts](/Users/dylanvu/innies/api/src/routes/analytics.ts#L562)
  - [api/src/repos/analyticsRepository.ts](/Users/dylanvu/innies/api/src/repos/analyticsRepository.ts#L84)
- Current analytics windows are `24h|7d|1m|all`; there is no `5h` window today.
- Current chart granularity is `hour|day`; there is no sub-hour granularity today.
- Current timeseries supports only a single token series per request via `credentialId`; there is no multi-token or multi-buyer chart API today.
- Current backend exposes token analytics and top buyers, but not a full buyer-key analytics table or buyer-key timeseries.
- Current backend does not expose recent token lifecycle events as a read API; `maxed|reactivated|probe_failed` are stored, but not surfaced for a UI event rail.
- Current backend does not expose a live analytics stream; polling will be needed unless we add SSE/WebSocket support.
- Current backend does not expose a single dashboard snapshot endpoint; a live page would otherwise need to poll and merge several endpoints with slightly different timestamps.
- Current schema does not store a safe user-facing truncated key fingerprint for buyer keys or token credentials.
  - Buyer keys store `key_hash`, not the raw key string.
  - Token credentials store encrypted access tokens, but we should not decrypt and render raw secrets in UI.
- `in_api_keys.name` and `in_token_credentials.debug_label` already provide usable operator labels for many rows.
- `in_api_keys.last_used_at` is auth activity, not a reliable buyer-usage "last seen" timestamp for analytics; buyer last-seen should come from `in_routing_events.created_at`.
- Recent request previews are best-effort:
  - prompt/response preview text is primarily populated for successful token-mode requests
  - request rows can still exist without preview text, especially on seller-mode or failed paths

## Data Semantics To Respect
- Source attribution is:
  - explicit `request_source`
  - else pinned CLI provider mapping
  - else `openclaw_run_id`
  - else `direct`
- A generated fallback `run_${requestId}` should not be treated as proof the request came from OpenClaw.
- Token rows from `/v1/admin/analytics/tokens` are currently attempt-based, not distinct-request-based.
- System and timeseries request counts are currently distinct-`request_id` counts.
- `/v1/admin/analytics/requests` is attempt-level and can contain duplicate `requestId` values.
- `/v1/admin/analytics/tokens/health` ignores `source` today.
- `maxedEvents7d` is always trailing 7 days, regardless of selected dashboard window.
- `authFailures24h` and `rateLimited24h` are always trailing 24 hours, regardless of selected dashboard window.
- Persisted `ttfb_ms` is currently "dispatch -> upstream headers received"; true streamed first-byte timing is only logged, not durably stored.

## Product Decisions
- Keep the existing Innies background/shell treatment. Do not redesign the page around a dark terminal backdrop.
- Make the page feel terminal-like through typography, spacing, borders, labels, and control shapes.
- Use monospace as the primary dashboard voice.
  - Preferred: `IBM Plex Mono`
  - Fallback: `SFMono-Regular`, `Menlo`, `Monaco`, `Consolas`, monospace
- Use dense tabular layout, segmented filter controls, hard-edged panels, compact labels, and right-aligned numeric columns.
- Treat "truncated keys" as safe display fingerprints, not raw secrets.
- Do not expose an admin API key to the browser.
  - the analytics page should fetch through a server-backed path
  - client polling should hit same-origin UI/server endpoints, not the admin API directly

## Terminal Theme Direction
- Typography:
  - mono everywhere the user scans numbers, labels, states, and controls
  - uppercase micro-labels for panel headers and toggles
- Panels:
  - thin borders
  - sharp or lightly rounded corners
  - visible dividers between sections
  - subtle inset treatment, not soft marketing-card UI
- Buttons and filters:
  - segmented-control style
  - compact
  - active state should feel like a selected terminal tab, not a soft pill
- Tables:
  - ledger/monitor aesthetic
  - fixed-width columns where possible
  - numbers aligned right
  - row selection should feel like "tracking" a line
- Live state:
  - `LIVE` badge in header
  - last-update timestamp
  - flash animation on incrementing usage cells
  - optional subtle cursor/blink accent near live badge

## Page Layout

### Desktop
```text
┌ ANALYTICS ─────────────────────────────────────────── LIVE ● 12:04:33 UTC ┐
│ [5H] [24H] [1W] [1M]                              auto-refresh: ON        │
├────────────────────────────────────────────────────────────────────────────┤
│ TOTAL REQS │ TOTAL UNITS │ ACTIVE TOKENS │ MAXED TOKENS │ ERROR │ FALLBACK│
├────────────────────────────────────────────────────────────────────────────┤
│ TOKEN CREDENTIALS                                │ BUYER KEYS             │
│ sortable table                                  │ sortable table         │
│ live delta flash                                │ live delta flash       │
│ select rows to chart                            │ select rows to chart   │
├────────────────────────────────────────────────────────────────────────────┤
│ HISTORICAL SERIES                                                        │
│ [TOKENS] [BUYERS] [USAGE] [REQUESTS] [LATENCY]                           │
│ lightweight-charts multi-series view                                     │
├────────────────────────────────────────────────────────────────────────────┤
│ HOT EVENTS / WARNINGS                                                     │
│ maxed -> reactivated, anomaly badges, fallback spikes, stale data flags  │
└────────────────────────────────────────────────────────────────────────────┘
```

### Mobile
- same sections
- stacked vertically
- filter bar stays sticky
- chart above tables when rows are selected
- tables collapse secondary columns behind an expandable row

## Required v1 Sections

### 1. Filter Bar
Must include:
- `5h`
- `24h`
- `1w`
- `1m`

Also include:
- `LIVE` status badge
- last successful update time
- optional pause/resume live updates control

Assumption:
- changing the window updates summary stats, tables, and charts together

### 2. Summary Strip
Show at least:
- total requests
- total usage units
- active tokens
- maxed tokens
- error rate
- fallback rate
- optional: latency p50 / TTFB p50

Primary source:
- existing `GET /v1/admin/analytics/system`

Useful if cheap:
- source mix mini-breakdown
- provider share mini-breakdown
- top model snapshot

Semantic note:
- if we later add source-scoped dashboard views, do not imply token inventory counts are source-scoped unless backend semantics are changed; current token counts in system summary are provider-scoped, not source-scoped.

### 3. Token Credentials Table
Must show all token credentials with:
- display fingerprint / truncated display id
- debug label
- provider
- current status
- usage units in selected window
- attempts in selected window
- live delta since previous poll

Recommended additional columns:
- percent of selected-window usage
- utilization rate 24h
- maxed events 7d
- monthly contribution used / limit
- latency p50
- auth failures 24h
- rate limits 24h

Row behavior:
- selectable for charting
- sortable by usage, attempts, provider, status, delta
- flash updated usage/attempt cells when values increase

Primary sources:
- existing `GET /v1/admin/analytics/tokens`
- existing `GET /v1/admin/analytics/tokens/health`
- existing `GET /v1/admin/analytics/tokens/routing`

Implementation note:
- build this table from token health as the base inventory so zero-usage credentials still render
- overlay `/tokens` and `/tokens/routing` metrics by `credentialId`

Labeling note:
- use `Attempts` in the table and sort controls unless backend semantics are changed to true request counts
- label `Maxed 7d`, `Auth Failures 24h`, and `Rate Limits 24h` exactly as fixed-window metrics

### 4. Buyer Keys Table
Must show all buyer keys with:
- display fingerprint / truncated display id
- buyer key label/name
- org id or org label if available
- preferred provider / effective provider
- usage units in selected window
- requests in selected window
- live delta since previous poll

Recommended additional columns:
- percent of total usage
- last seen timestamp
- source mix
- request error rate

Row behavior:
- selectable for charting
- sortable by usage, requests, label, preferred provider, delta
- flash updated usage/request cells when values increase

Current gap:
- backend does not currently expose a full buyer-key analytics table
- current system summary only exposes `topBuyers`
- buyer `lastSeenAt` should be derived from routed usage activity, not auth middleware `last_used_at`
- the buyer table must be inventory-based so zero-usage buyer keys still appear

### 5. Historical Chart Panel
Must allow:
- token series toggling
- buyer series toggling
- switching between `usage units` and `requests`

Recommended secondary chart modes:
- latency
- error rate
- fallback rate
- TTFB

Behavior:
- selected rows from the token table become chart series in token mode
- selected rows from the buyer table become chart series in buyer mode
- cap active series count to keep chart readable
  - recommended limit: `6`

Important implementation note:
- current backend only supports one token series per timeseries request
- buyer timeseries does not exist yet
- v1 therefore needs either:
  - client fan-out plus merge across multiple requests, or
  - a dedicated multi-entity timeseries endpoint
- preferred direction:
  - tokens: client fan-out is acceptable in v1 with a hard cap on selected series
  - buyers: dedicated backend support is required
- chart labeling should be explicit:
  - token table = `Attempts`
  - chart `Requests` mode = distinct request counts from timeseries data

Chart library:
- use `lightweight-charts`
- reuse setup ideas from:
  - [/Users/dylanvu/percent/ui/components/LiveMultiSeriesChart.tsx](/Users/dylanvu/percent/ui/components/LiveMultiSeriesChart.tsx)
  - [/Users/dylanvu/percent/ui/components/stats/VolumeChartCard.tsx](/Users/dylanvu/percent/ui/components/stats/VolumeChartCard.tsx)

Recommendation:
- use `lightweight-charts`, not TradingView Advanced Charts
- Innies does not need broker/trading UI complexity here

### 6. Useful Extras
These are worth including in v1 if cheap:
- anomaly badge strip from `GET /v1/admin/analytics/anomalies`
- recent token lifecycle ticker:
  - `maxed`
  - `reactivated`
  - `probe_failed`
- source mix mini-breakdown:
  - `openclaw`
  - `cli-claude`
  - `cli-codex`
  - `direct`
- selected-row drilldown link into recent requests filtered by token
  - preview text should be treated as best-effort, not guaranteed full body history

Also useful for an operator-facing viewer:
- concentration strip:
  - top `1`, `3`, and `5` tokens as a share of total usage
  - top `1`, `3`, and `5` buyers as a share of total usage
- per-key usage distribution chart:
  - prefer sorted horizontal bars or a treemap
  - avoid raw pie charts for high-cardinality key lists
  - pie/donut is acceptable for low-cardinality breakdowns such as `provider` or `source`
- monthly contribution burn bars for token credentials:
  - `used / limit`
  - especially useful for spotting tokens heating up before maxing
- row sparklines for top tokens and top buyers:
  - quick "heating up / cooling off" scan without opening the large chart
- error composition panel:
  - top error codes by token
  - useful alongside error rate because `401`, `429`, and `5xx` imply different action
- slow / error outlier list:
  - recent highest-latency requests
  - recent non-2xx requests
  - useful as a compact operator queue beside the larger chart
- fallback / maxing risk watchlist:
  - high `fallbackCount`
  - high `authFailures24h`
  - high `rateLimited24h`
  - high `maxedEvents7d`

## Backend Scope Required

### A. Add `5h` Window Support
Current analytics contract only supports `24h|7d|1m|all`.

Required changes:
- add `5h` to analytics query schemas in [api/src/routes/analytics.ts](/Users/dylanvu/innies/api/src/routes/analytics.ts#L81)
- add `5h` support to window helpers in:
  - [api/src/repos/analyticsRepository.ts](/Users/dylanvu/innies/api/src/repos/analyticsRepository.ts#L13)
  - [api/src/utils/analytics.ts](/Users/dylanvu/innies/api/src/utils/analytics.ts#L25)

### B. Add Finer Chart Granularity
Current timeseries supports only `hour|day`. That is too coarse for `5h`.

Required changes:
- add `5m` granularity for `5h`
- optionally add `15m` for `24h`

Recommended mapping:
- `5h` -> `5m`
- `24h` -> `15m`
- `1w` -> `hour`
- `1m` -> `day`

Important note:
- if we keep the current `/timeseries` shape, multi-series token charting requires one request per selected token and client-side merge
- that is acceptable as a fallback, but not ideal for a live operator page

### C. Add Buyer-Key Analytics Endpoints
Required new read endpoints:
- `GET /v1/admin/analytics/buyers`
  - full buyer-key usage table for selected window
- `GET /v1/admin/analytics/buyers/timeseries`
  - buyer-key chart series by window and granularity

Recommended response fields for `/buyers`:
- `apiKeyId`
- `displayKey`
- `label`
- `orgId`
- `orgLabel` (optional; only if cheaply available)
- `preferredProvider`
- `effectiveProvider`
- `requests`
- `usageUnits`
- `retailEquivalentMinor`
- `percentOfTotal`
- `lastSeenAt`
- `sourceMix`
- `errorRate`

Recommended response fields for `/buyers/timeseries`:
- `bucket`
- `apiKeyId`
- `requests`
- `usageUnits`

Data source:
- `in_routing_events.api_key_id`
- `in_usage_ledger`
- `in_api_keys.name`
- `in_api_keys.preferred_provider`

Important implementation note:
- `lastSeenAt` should come from `max(in_routing_events.created_at)`
- do not use `in_api_keys.last_used_at` for analytics display because auth touches it on every authenticated request
- `/buyers` should return all buyer keys with scope `buyer_proxy`, including zero-usage rows in the selected window
- preferred provider should come directly from the API key record; effective provider should be derived from default-provider policy

### D. Add Lifecycle Event Read Endpoint
Required new read endpoint:
- `GET /v1/admin/analytics/events`
  - recent operator-relevant lifecycle and warning events

Recommended response categories:
- token lifecycle:
  - `maxed`
  - `reactivated`
  - `probe_failed`
- system warnings:
  - stale aggregate windows
  - aggregate mismatch count
  - fallback spikes if we decide to derive them

Recommended response fields:
- `id`
- `type`
- `createdAt`
- `provider`
- `credentialId`
- `credentialLabel`
- `summary`
- `severity`
- `metadata`

Data source:
- `in_token_credential_events`
- `GET /v1/admin/analytics/anomalies` or shared anomaly query logic

### E. Add Dashboard Snapshot Endpoint Or Explicit Fan-Out Plan
The page needs several live-updating sections at once:
- summary strip
- token table
- buyer table
- anomalies
- optional event rail

If we rely on many parallel polls, the page will show slightly different sample times and delta flashes can become noisy.

Preferred v1 addition:
- `GET /v1/admin/analytics/dashboard`
  - returns a single snapshot envelope for summary + token rows + buyer rows + anomalies + recent events

Minimum acceptable fallback:
- document a client fan-out strategy
- poll all component endpoints together
- stamp one client-side `snapshotAt`
- compute deltas only when all required responses for a cycle succeed

### F. Add Safe Display Fingerprints
User requirement calls for truncated keys, but this should not block first ship.

Required backend support:
- add safe `display_fingerprint` field to:
  - `in_api_keys`
  - `in_token_credentials`

Rules:
- never expose raw secret
- fingerprint should be stable and human-distinguishable
- existing rows can temporarily fall back to short UUID display until real fingerprints exist

Suggested fallback format until schema lands:
- token credentials: `cred_12ab…9fe2`
- buyer keys: `key_87cd…21aa`

Recommendation:
- v1 can ship with UUID-based fallback display ids plus:
  - token `debugLabel`
  - buyer key `name`

Hard rule:
- do not ship UI that decrypts token secrets to derive display text
- do not try to reconstruct buyer key display text from `key_hash`

### G. Live Updates
There is no live analytics stream today.

Recommendation for v1:
- short polling, not SSE
- this still satisfies "live, no page refresh"

Recommended cadence:
- `5h` / `24h`: poll summary and tables every `2-3s`
- `1w` / `1m`: poll summary and tables every `5-10s`
- charts: poll every `10s`

Consistency rules:
- compute row deltas against the last fully successful poll cycle
- if one endpoint in a cycle fails, do not partially update delta state
- keep last good data rendered and mark live status as degraded

Optional phase 2:
- add `GET /v1/admin/analytics/live`
  - SSE stream of delta events for token and buyer usage

### H. Request Semantics Cleanup
The current analytics contract mixes attempt counts and distinct-request counts.

Required v1 decision:
- either keep current semantics and label them honestly in UI
- or add backend changes so token rows and buyer rows expose both:
  - `attempts`
  - `requests`

Recommendation:
- v1 should be explicit:
  - token table uses `attempts`
  - system summary keeps `requests`
  - chart mode labels should say `Attempts` or `Requests` based on the series source

### I. Request Drilldown Fixup
If we use the requests endpoint as a drilldown surface, the current response shape is missing one useful field.

Recommended backend addition:
- add `attemptNo` to `GET /v1/admin/analytics/requests`

Reason:
- current request drilldown is attempt-level and may contain duplicate `requestId` values
- exposing `attemptNo` avoids ambiguous UI rows

## Frontend Scope Required

### Page Structure
- replace the empty route in [ui/src/app/analytics/page.tsx](/Users/dylanvu/innies/ui/src/app/analytics/page.tsx#L1)
- keep the current analytics shell background in [ui/src/app/analytics/page.module.css](/Users/dylanvu/innies/ui/src/app/analytics/page.module.css#L1)
- do not build this page on top of `mockAdapters`
- define the server-backed fetch path before building polling/chart components

Recommended file split:
- `ui/src/app/analytics/page.tsx`
- `ui/src/app/analytics/page.module.css`
- `ui/src/components/analytics/AnalyticsConsole.tsx`
- `ui/src/components/analytics/WindowTabs.tsx`
- `ui/src/components/analytics/SummaryStrip.tsx`
- `ui/src/components/analytics/EntityUsageTable.tsx`
- `ui/src/components/analytics/UsageDeltaCell.tsx`
- `ui/src/components/analytics/AnalyticsChart.tsx`
- `ui/src/components/analytics/EventRail.tsx`

### Styling
- do not use inline-style-only implementation for the final page
- prefer CSS modules
- keep it dense and scan-friendly
- no oversized hero-card spacing
- strong emphasis on:
  - column rhythm
  - numeric alignment
  - row selection state
  - compact controls

### Chart Integration
Required dependency:
- add `lightweight-charts` to `ui/package.json`

Implementation notes:
- adapt chart initialization patterns from the `percent` UI
- keep charts minimal:
  - transparent background
  - mono labels
  - clean crosshair
  - toggle legend outside chart area

## Live Update UX
- compare current poll payload vs previous payload by entity id
- when `usageUnits` or `requests` increase:
- when `usageUnits` or `attempts` increase:
  - animate cell flash for `800-1200ms`
  - show small inline delta such as `+124`
- if an entity disappears due to filters, remove without flash
- if polling fails:
  - keep last good data on screen
  - mark `LIVE` badge as degraded
  - show last successful update timestamp

## Recommended v1 Sort Order
- Tokens: `usageUnits desc`
- Buyers: `usageUnits desc`

Secondary sort toggles:
- attempts
- live delta
- provider
- status
- label

## Nice-to-Have, But Not Required For First Ship
- row search
- pinned rows
- remember selected chart series in URL params
- request preview drawer using `/v1/admin/analytics/requests`
- source filter chips
- provider filter chips
- table virtualization if row counts become large

## Implementation Sequence
1. Backend contract work
- add `5h`
- add finer timeseries granularity
- add buyer analytics endpoints
- add lifecycle event read endpoint
- add dashboard snapshot endpoint or explicitly choose client fan-out
- define temporary UUID-based display fallback; fingerprint schema can follow

2. Frontend shell
- replace empty analytics route
- add terminal-style layout and filter bar
- wire summary strip and live badge

3. Token and buyer tables
- sortable tables
- live polling
- delta flash behavior
- explicit attempts-vs-requests labels

4. Chart panel
- lightweight-charts
- token/buyer row toggles
- window-aware chart resolution

5. Extras
- anomaly strip
- lifecycle event rail
- filtered request drilldown links

## Testing Scope
- extend [api/tests/analytics.route.test.ts](/Users/dylanvu/innies/api/tests/analytics.route.test.ts#L1) for:
  - `5h`
  - finer granularity defaults and validation
  - buyer analytics endpoints
  - lifecycle event endpoint
  - dashboard snapshot endpoint if added
- extend [api/tests/analyticsRepository.test.ts](/Users/dylanvu/innies/api/tests/analyticsRepository.test.ts#L1) and [api/tests/analyticsRepository.anomalies.test.ts](/Users/dylanvu/innies/api/tests/analyticsRepository.anomalies.test.ts#L1) for new SQL/filter behavior
- add frontend coverage for:
  - polling success/failure and degraded live state
  - row selection to chart-series wiring
  - delta flash behavior
  - empty preview state in request drilldown

## Success Criteria
- An operator can open `/analytics` and immediately see which tokens and buyer keys are hottest.
- Usage values update live without refreshing the page.
- Incrementing rows visibly flash on update.
- The `5h`, `24h`, `1w`, and `1m` filters feel native and useful.
- Selected tokens and buyers can be compared historically on one chart once multi-entity chart data is wired.
- The page feels like an internal operator console, not a marketing dashboard.
