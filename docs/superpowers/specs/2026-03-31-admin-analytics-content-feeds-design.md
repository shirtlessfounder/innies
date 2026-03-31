# Admin Analytics Content Feeds Design

## Goal

Add four admin analytics feeds that make Innies' stored routing and preview data directly useful for operator analysis and public storytelling without crossing the safe-preview boundary.

The user explicitly wants:

- richer request drilldown for real-session examples
- daily trend reporting over recent windows
- token contribution-cap cycle history
- approximate coding-session analytics
- no full archive reads in v1

## Context

Innies already has an admin analytics surface in:

- `api/src/routes/analytics.ts`
- `api/src/repos/analyticsRepository.ts`

That surface already exposes:

- per-token usage, health, and routing
- system and buyer summaries
- time-series analytics
- recent request drilldown
- token lifecycle events
- dashboard snapshots

The current storage model is already close to what this feature needs:

- `in_routing_events`
  - attempt-level routing truth
- `in_usage_ledger`
  - attempt-level usage truth
- `in_request_log`
  - safe prompt/response previews
- `in_token_credential_events`
  - durable token lifecycle history

Recent prompt archive work added deeper storage, but the user wants these new feeds to stay on the safe-preview boundary for now. Full archive access should be a separate future surface.

## Scope

In scope:

- expand `GET /v1/admin/analytics/requests`
- add `GET /v1/admin/analytics/daily-trends`
- add `GET /v1/admin/analytics/cap-history`
- add `GET /v1/admin/analytics/sessions`
- repository queries, route validation, normalization, and tests
- documentation updates for the new feeds

Out of scope:

- full archived prompt/response reads
- new storage tables, jobs, or materialized views
- dashboard snapshot integration or caching for these feeds
- a canonical persisted session model
- UI work

## Current State

Relevant existing code:

- route/query validation and response normalization:
  - `api/src/routes/analytics.ts`
- analytics SQL:
  - `api/src/repos/analyticsRepository.ts`
- request preview storage:
  - `api/src/repos/requestLogRepository.ts`
- routing attribution and request history seams:
  - `api/src/repos/routingAttributionRepository.ts`
- source derivation helpers:
  - `api/src/utils/analytics.ts`
- analytics tests:
  - `api/tests/analytics.route.test.ts`
  - `api/tests/analyticsRepository.test.ts`
- analytics docs:
  - `docs/ANALYTICS.md`

Important current behavior:

- `GET /v1/admin/analytics/requests` already joins:
  - `in_routing_events`
  - `in_usage_ledger`
  - `in_request_log`
  - `in_token_credentials`
- that route already returns safe previews only
- query defaults and filter semantics already exist for:
  - `window`
  - `provider`
  - `source`
  - `orgId`

## Design Summary

Implement this as an extension of the existing analytics route/repository seam.

Do not create a separate analytics subsystem.

Do not introduce new storage.

Use SQL-first derivation inside `AnalyticsRepository`, keep `analytics.ts` as thin validation and normalization glue, and preserve the current safe-preview boundary.

## API Surface

### 1. Expand `GET /v1/admin/analytics/requests`

Keep the existing path and make it the primary request-content drilldown feed.

Add support for:

- cursor pagination
- stable descending ordering by `(created_at, request_id, attempt_no)`
- richer output field names and normalization

Accepted filters:

- `window`
- `provider`
- `source`
- `orgId`
- `credentialId`
- `model`
- `minLatencyMs`
- `limit`
- `cursor`

Response shape:

- `window`
- `limit`
- `requests`
  - `requestId`
  - `attemptNo`
  - `createdAt`
  - `credentialId`
  - `credentialLabel`
  - `provider`
  - `model`
  - `source`
  - `translated`
  - `rescued`
  - `rescueScope`
  - `rescueInitialProvider`
  - `rescueInitialCredentialId`
  - `rescueInitialFailureCode`
  - `rescueInitialFailureStatus`
  - `streaming`
  - `upstreamStatus`
  - `latencyMs`
  - `ttfbMs`
  - `inputTokens`
  - `outputTokens`
  - `usageUnits`
  - `promptPreview`
  - `responsePreview`
- `nextCursor`

Purpose:

- an operator/tweet-mining feed for examples of real safe-preview traffic

### 2. Add `GET /v1/admin/analytics/daily-trends`

New endpoint for daily aggregate trends.

Accepted filters:

- `window`
  - expected main usage: `7d` and `30d`/`1m`
- `provider`
- `source`
- `orgId`

Response shape:

- `window`
- `days`
  - `day`
  - `requests`
  - `attempts`
  - `usageUnits`
  - `inputTokens`
  - `outputTokens`
  - `errorRate`
  - `avgLatencyMs`
  - `providerSplit`
  - `sourceSplit`

Purpose:

- tweet-ready “how usage changed over time” data without extra client aggregation

### 3. Add `GET /v1/admin/analytics/cap-history`

New endpoint for token contribution-cap cycle history.

Accepted filters:

- `window`
- `provider`
- `orgId`
- `credentialId`
- `limit`
- `cursor`

Response shape:

- `window`
- `cycles`
  - `credentialId`
  - `credentialLabel`
  - `provider`
  - `windowKind`
    - `5h`
    - `7d`
    - `unknown`
  - `exhaustedAt`
  - `clearedAt`
  - `recoveryMinutes`
  - `usageUnitsBeforeCap`
  - `requestsBeforeCap`
  - `exhaustionReason`
- `nextCursor`

Purpose:

- expose Innies' most unique operational data: cap timing, recovery timing, and usage before exhaustion

### 4. Add `GET /v1/admin/analytics/sessions`

New endpoint for approximate coding-session analytics.

Accepted filters:

- `window`
- `provider`
- `source`
- `orgId`
- `limit`
- `cursor`
- `idleMinutes`

Response shape:

- `window`
- `idleMinutes`
- `sessions`
  - `sessionKey`
  - `groupingBasis`
    - `explicit_session_marker`
    - `explicit_run_marker`
    - `request_id`
    - `idle_gap`
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
- `nextCursor`

Purpose:

- approximate “what a coding session looked like” summaries while making the heuristic visible to callers

## Data Sources and Query Strategy

### `requests`

Primary tables:

- `in_routing_events re`
- `in_usage_ledger ul`
- `in_request_log rl`
- `in_token_credentials tc`

Strategy:

- extend the existing `getRecentRequests(...)` query
- keep current joins
- add cursor filter on:
  - `re.created_at`
  - `re.request_id`
  - `re.attempt_no`
- continue filtering on routing-source/provider/org and usage joins exactly as the current analytics stack does

Boundary:

- do not join archive tables
- do not expose `fullPrompt` or `fullResponse`

### `daily-trends`

Primary tables:

- `in_routing_events re`
- `in_usage_ledger ul`

Strategy:

- derive UTC-day buckets from raw routing/usage tables
- aggregate:
  - distinct request count
  - attempt count
  - usage/token sums
  - latency averages
  - error-rate by failed attempts
- derive `providerSplit` and `sourceSplit` in SQL so the route stays thin
- generate zero rows for missing days inside the requested range so charts do not have holes

Why raw tables instead of `in_daily_aggregates`:

- existing admin analytics already treat routing and usage tables as source of truth
- this endpoint needs provider and source splits in the same semantics as the rest of the analytics surface
- v1 correctness matters more than aggregate reuse

Future optimization:

- if query cost becomes an issue, closed-day reads can later pull from `in_daily_aggregates` and only use raw tables for the current day

### `cap-history`

Primary tables:

- `in_token_credential_events tce`
- `in_token_credentials tc`
- `in_routing_events re`
- `in_usage_ledger ul`

Strategy:

- identify `contribution_cap_exhausted` events as cycle start points
- pair each exhaustion event with the next matching `contribution_cap_cleared` for:
  - the same `token_credential_id`
  - the same `metadata.window` value when present
- compute `usageUnitsBeforeCap` and `requestsBeforeCap` by summing usage/routing between:
  - the prior clear event for that credential/window when it exists
  - otherwise the beginning of the requested analytics window
  - and the exhaustion event timestamp

Open-cycle behavior:

- if no clear event exists after exhaustion:
  - `clearedAt = null`
  - `recoveryMinutes = null`
- still return the row

Why this is acceptable:

- “still capped” rows are operationally valuable and tweet-worthy

### `sessions`

Primary tables:

- `in_routing_events re`
- `in_usage_ledger ul`
- `in_request_log rl`

Deterministic grouping priority:

1. `re.route_decision->>'openclaw_session_id'`
2. `re.route_decision->>'openclaw_run_id'`
3. `re.request_id`

Fallback grouping:

- for requests without deterministic linkage, partition by a conservative actor lane:
  - `re.org_id`
  - `re.api_key_id`
  - derived `source`
- order by `re.created_at`
- start a new session when the gap to the previous row exceeds `idleMinutes`

Session aggregates:

- time bounds
- request and attempt counts
- usage/token sums
- distinct providers/models/credentials
- provider switch count
- a small number of preview samples

Important truth boundary:

- `sessions` is an approximation, not a canonical session model
- the response should explicitly tell consumers which grouping basis produced each row

## Detailed Endpoint Semantics

### Request Cursor

Encode the cursor as a base64url JSON object containing:

- `createdAt`
- `requestId`
- `attemptNo`

Use descending lexical/timestamp ordering matching the query's `ORDER BY`.

### Cap-History Cursor

Encode the cursor as a base64url JSON object containing enough to page stably through cycle rows:

- `exhaustedAt`
- `credentialId`
- `windowKind`
- `eventId`

### Sessions Cursor

Encode the cursor from session summary ordering keys:

- `startedAt`
- `sessionKey`

### Session Samples

Do not return every preview in a session.

Return a small bounded sample, for example:

- first `N` non-null prompt previews
- first `N` non-null response previews

This keeps the endpoint tweet-useful without turning it into a bulk content export.

## Validation and Defaults

Follow current analytics conventions in `analytics.ts`.

Defaults:

- `requests.limit`
  - keep existing default behavior unless adjusted for pagination symmetry
- `daily-trends.window`
  - default `7d`
- `cap-history.limit`
  - default `50`
- `sessions.limit`
  - default `20`
- `sessions.idleMinutes`
  - default `30`

Provider normalization:

- accept `codex`
- normalize to canonical `openai` behavior just like the current analytics filters do

## Testing

### Route Tests

Add route coverage in `api/tests/analytics.route.test.ts` for:

- admin auth enforcement
- query validation and defaults
- cursor parsing failures
- success responses for:
  - expanded `requests`
  - `daily-trends`
  - `cap-history`
  - `sessions`

### Repository Tests

Add SQL-shape and result-shape coverage in `api/tests/analyticsRepository.test.ts` for:

- `requests`
  - cursor ordering and pagination predicate
  - safe-preview joins still present
- `daily-trends`
  - UTC-day bucketing
  - provider/source split derivation
  - usage-only joins constrained to canonical `entry_type = 'usage'`
- `cap-history`
  - exhaustion/clear pairing by credential and window
  - usage-before-cap sums anchored to prior clear or window start
  - open cycles returning null recovery fields
- `sessions`
  - explicit marker priority over idle-gap fallback
  - deterministic grouping from `openclaw_session_id`
  - fallback clustering based on inactivity threshold

### Docs

Update `docs/ANALYTICS.md` to document:

- new endpoints
- safe-preview boundary
- `sessions` heuristic nature
- `cap-history` semantics for open cycles

## Risks

- `sessions` may be the most complex SQL in the analytics repository and may need refinement once real traffic is inspected
- idle-gap clustering can merge unrelated work if the same buyer key is used continuously without explicit markers
- cap-cycle pairing depends on event metadata quality for the `window` value
- `daily-trends` from raw tables may be more expensive than a precomputed aggregate approach, especially for broad windows

## Mitigations

- keep the session grouping basis explicit in the API response
- keep v1 on recent windows and bounded limits
- write repository tests around event-window pairing and marker priority
- defer caching, jobs, and materialized rollups until actual query cost justifies them

## Recommendation

Implement the four feeds as additive extensions to the existing admin analytics surface:

- expand `GET /v1/admin/analytics/requests`
- add `GET /v1/admin/analytics/daily-trends`
- add `GET /v1/admin/analytics/cap-history`
- add `GET /v1/admin/analytics/sessions`

Keep everything SQL-first, safe-preview only, and route-light.

That gets the user the tweetable operational dataset they want now while leaving full archive analytics and precomputed rollups as separate future work.
