# Token Contribution Caps Scope

Date: 2026-03-12

## Objective
Ship per-token contribution caps for Anthropic/Claude OAuth credentials using provider-reported quota usage instead of purely local inference.

Success means:
- each Claude token can reserve `X%` of its provider-reported 5-hour capacity and `Y%` of its provider-reported 7-day capacity for personal use
- Innies pooled routing stops using that token once either shared portion is exhausted
- Innies stores and shows both current 5-hour and 7-day quota state per token
- token-credential dashboard rows show normalized `5H CAP` and `7D CAP` progress toward the effective shared cap
- Claude quota exhaustion and recovery use provider quota state instead of empirical `429 -> maxed -> probe`
- local contribution-cap exclusion stays clearly separate from auth-failure `maxed` / probe lifecycle
- operators can inspect reserve %, current usage, reset times, and why a token is excluded

## Scope Boundary
V1 is Claude-only.

In scope:
- Anthropic / Claude OAuth credentials
- provider-reported `5h` usage state
- provider-reported `7d` usage state
- 5-hour reserve enforcement
- 7-day reserve enforcement
- 7-day state storage + visibility
- replacing Claude's `429`-driven auto-`maxed` / probe quota lifecycle with provider quota state

Out of scope for this feature:
- Codex/OpenAI tokens
- empirical capacity inference as the primary routing control for Claude
- changing auth-failure `maxed` / probe semantics
- changing non-Claude `maxed` / probe semantics

Reason:
- Codex limits have not been a real operational problem so far
- Claude appears to expose actual quota usage + reset windows, which is better than inference when available

## Core Product Rule
Do not overload current auth-failure `maxed` behavior for this feature.

Current `maxed` means:
- credential-health quarantine after repeated auth-like failures
- probe-driven reactivation
- lifecycle analytics anchored on real upstream failures

Claude quota exhaustion and contribution-cap exhaustion are different:
- they are quota-state routing exclusions, not credential-health quarantine
- they should reopen automatically as provider quota state recovers
- they should not require probe reactivation
- they should not emit or reuse auth-failure `maxed` lifecycle events

Recommended rule:
- keep `maxed` + probe for real auth/credential invalidation
- for Claude, stop using repeated `429`s as the durable trigger for `maxed`
- allow transient Claude `429`s to continue marking a token as temporarily `rate_limited`
- add separate local routing/debug reasons such as `contribution_cap_exhausted` or provider-quota exhaustion

## New Direction
Previous drafts focused on empirical 5-hour estimation from `429 -> maxed -> reactivated` history.

This scope changes direction for Claude:
- use Anthropic's provider-reported OAuth usage endpoint as the source of truth for current 5-hour and 7-day usage state
- use Innies-local reserve percentages to decide when pooled traffic should stop using a token
- use the same provider usage state as the Claude quota-exhaustion source of truth instead of `15x 429 -> maxed -> probe`
- keep existing empirical analytics if useful later, but do not make them the primary routing gate for Claude contribution caps

Important distinction:
- do not use the Twitter statusline project itself as runtime infrastructure
- use the underlying Anthropic usage endpoint that project discovered

## Product Definition
Each Claude token gets a reserve percentage.

Example:
- provider-reported 5h utilization = `76%`
- token reserve = `20%`
- pooled share = `80%`
- token remains routable for pooled traffic while 5h utilization is below `80%`
- once 5h utilization reaches `80%` or above, Innies skips that token for pooled routing

Intent:
- the reserved headroom is left unused by Innies pooled traffic
- the token owner can consume that reserved headroom personally outside the pooled lane

## Window Model
Anthropic appears to expose two overlapping windows:
- `5h` session-style quota window
- `7d` weekly quota window

V1 behavior:
- enforce reserve on `5h`
- enforce reserve on `7d`
- store and show both windows and their reset times

Why:
- 5-hour exhaustion is the immediate routing-control problem
- weekly exhaustion can also take a token out of safe pooled service
- both windows are already exposed by the provider state we plan to store

## Current State
Current token-mode routing already respects:
- credential `status`
- expiry
- temporary `rate_limited_until`
- monthly contribution limits

Current routing does not protect short-window headroom for contributors.

Current token and analytics behavior in this repo:
- successful token-routed attempts append canonical `entry_type='usage'` rows to `in_usage_ledger`
- token attribution for those usage rows is indirect today via routing metadata joins
- OAuth/session credentials track repeated `429`s separately from auth-like failures
- `5` consecutive `429`s -> temporary `rate_limited_until` cooldown
- `15` consecutive `429`s -> auto-`maxed` today
- hard-`maxed` credentials are later probed for reactivation today

Target Claude behavior after this scope:
- transient `429`s can still mark a token as temporarily `rate_limited`
- repeated Claude `429`s should no longer auto-`max` the credential for quota exhaustion
- provider quota snapshot becomes the source of truth for Claude quota exhaustion and reopen timing
- auth-like failures can still `max` a Claude credential and keep the current probe lifecycle

Relevant current code:
- routing lifecycle: [api/src/routes/proxy.ts](../../api/src/routes/proxy.ts)
- token state + 429/maxing logic: [api/src/repos/tokenCredentialRepository.ts](../../api/src/repos/tokenCredentialRepository.ts)
- current analytics capacity estimation: [api/src/repos/analyticsRepository.ts](../../api/src/repos/analyticsRepository.ts)
- current analytics contract: [docs/ANALYTICS.md](../ANALYTICS.md)
- current API contract: [docs/API_CONTRACT.md](../API_CONTRACT.md)

## Provider Usage Source
V1 should add a provider-usage fetch path for Anthropic OAuth credentials.

Required provider state per token:
- `five_hour.utilization`
- `five_hour.resets_at`
- `seven_day.utilization`
- `seven_day.resets_at`

Recommended semantics:
- treat provider usage data as the current quota truth for Claude contribution-cap gating
- treat provider usage data as the current quota truth for Claude quota exhaustion / recovery as well
- store the raw current snapshot locally so routing and analytics do not need to call Anthropic on every request

Unit convention:
- store provider utilization in snapshot fields as ratios in the `0..1` range
- convert to percent only when applying routing thresholds or rendering operator-facing display
- example: provider utilization `0.76` means `76%`

## Configuration

### Per-Token Reserve
Recommended fields:
- `five_hour_reserve_percent`
- `seven_day_reserve_percent`

Recommended semantics:
- integer percent `0..100`
- default `0` on both fields
- `0` means no reserve for that window
- `20` means leave `20%` of the 5h capacity unused by pooled routing
- `20` on the weekly field means leave `20%` of the 7d capacity unused by pooled routing
- `100` means do not share this token into the pool at all

Recommended v1 default:
- reserve lives on individual tokens only
- no provider/org inherited defaults in v1

### Weekly Reserve
Enforced in v1.

Recommended v1 rule:
- add `seven_day_reserve_percent`
- default it to `0`
- skip pooled traffic when the weekly shared threshold is hit even if 5h is still under threshold

## Routing Behavior

### Eligibility
Routing should continue to exclude tokens for:
- `status != active`
- `expires_at <= now()`
- `rate_limited_until > now()`
- monthly contribution limit exhausted

Add one more exclusion:
- contribution-cap exhausted on provider-reported 5h utilization
- contribution-cap exhausted on provider-reported 7d utilization

Recommended effective routing order:
1. active / not revoked / not expired
2. transient rate-limit cooldown / auth-failure `maxed` checks
3. monthly contribution limit checks
4. provider-reported 5h contribution-cap checks
5. provider-reported 7d contribution-cap checks

Important Claude meaning:
- for Claude tokens, `status = 'maxed'` should mean credential-health quarantine, not ordinary quota exhaustion

### Contribution-Cap Check
For a token with reserves:
- `R5 = five_hour_reserve_percent`
- `R7 = seven_day_reserve_percent`
- `U5 = five_hour_utilization_ratio * 100`
- `U7 = seven_day_utilization_ratio * 100`

Pooled routing thresholds:
- `five_hour_shared_threshold = 100 - R5`
- `seven_day_shared_threshold = 100 - R7`

Skip token if either is true:
- `U5 >= five_hour_shared_threshold`
- `U7 >= seven_day_shared_threshold`

Examples:
- reserve `0` -> pooled threshold `100`
- reserve `20` -> pooled threshold `80`
- reserve `35` -> pooled threshold `65`
- if either 5h or 7d crosses its threshold, token is skipped

### Cap Progress Display
Operator-facing token rows should show cap progress as normalized progress toward the effective shared cap, not only raw provider utilization.

Recommended display fields:
- `5H CAP`
- `7D CAP`

Recommended semantics:
- show percent consumed toward the earlier of:
  - the provider hard limit for that window
  - the Innies shared-cap threshold for that window (`100 - reserve_percent`)
- for reserve `0`, display matches raw provider utilization for that window
- for reserve `20`, display reaches `100%` when provider utilization reaches `80%`
- clamp display to `100%` once the token is exhausted for pooled routing
- if reserve is `100`, treat shared cap as already fully consumed for pooled routing display purposes
- for non-Claude rows that do not participate in this feature yet, the UI can show `0%` as a placeholder in both cap columns

Suggested normalized calculation:
- if shared threshold `T > 0`, `normalized_cap_used_percent = min(100, (provider_utilization_percent / T) * 100)`
- if shared threshold `T = 0`, `normalized_cap_used_percent = 100`

Examples:
- 5h utilization `60%`, reserve `0%` -> `5H CAP = 60%`
- 5h utilization `60%`, reserve `20%` -> shared threshold `80%` -> `5H CAP = 75%`
- 5h utilization `84%`, reserve `20%` -> `5H CAP = 100%`

### Transient 429 Handling
Claude can still see transient upstream `429`s before the provider snapshot fully catches up or while a token is near the edge.

Recommended behavior:
- a transient Claude `429` can still mark the token as temporarily `rate_limited`
- short cooldown remains useful to avoid immediately hammering a token that just rejected traffic
- repeated Claude `429`s should not flip the credential into durable `maxed` for quota exhaustion
- if provider quota state says the window is exhausted, routing should skip because of provider usage state, not because the token was empirically `maxed`

### Repeated 429 Escalation
Claude still needs a non-`maxed` safeguard for repeated upstream `429`s.

Recommended v1 rule:
- keep the existing short cooldown for isolated or brief `429` streaks
- when a Claude token hits the repeated-`429` escalation threshold, do not set `status = 'maxed'` and do not schedule probe
- instead, extend the token's local `rate_limited_until` into a longer backoff window
- let the normal `1 minute` background provider-usage poller determine whether the token is actually exhausted for 5h, 7d, or reserve-threshold reasons
- clear that longer local backoff when either:
  - a fresh provider snapshot shows the token is below all active thresholds, or
  - a later upstream success proves the token is healthy again

Operational intent:
- avoid infinite churn through short cooldowns
- keep the safeguard local and reversible
- do not blur repeated `429` throttling into auth-failure `maxed`

Recommended v1 simplification:
- Claude can reuse the current repeated-`429` threshold as the escalation trigger
- the trigger outcome changes from `maxed + probe` to `longer local backoff`

### Burn Basis
The routing check should use all Innies traffic that hits that token.

Reason:
- provider quota is shared by all traffic on the token
- the reserve is meant to preserve headroom against total token burn, not only a subset of pooled requests

Important limitation:
- Innies can only observe traffic that goes through Innies
- if the owner also uses the same upstream account outside Innies, Anthropic's provider usage endpoint will reflect that, which is exactly what we want for protecting reserve headroom

### Release Semantics
Contribution-cap exhaustion should reopen automatically.

Simple behavior:
- when the latest provider-reported 5h utilization drops below the 5h pooled threshold and the latest provider-reported 7d utilization drops below the 7d pooled threshold, the token becomes eligible again

Reset handling:
- the provider reset timestamp is the earliest moment a token might become reusable for that window
- Innies should not blindly reopen exactly at the timestamp without refresh
- safer sequence:
  1. token is excluded because 5h or 7d threshold is hit
  2. reset time for that window arrives
  3. next provider poll refreshes token usage state
  4. token becomes eligible only if the refreshed utilization is below all active thresholds

No extra lifecycle machinery needed:
- no status flip
- no probe
- no durable "cleared" event required for correctness

This same reopen rule should replace Claude's current `429 -> maxed -> probe` recovery path for quota exhaustion.

## Visibility Model
Recommended v1 visibility:
- computed current-state fields in analytics/dashboard
- routing/debug reasons when a request skips a token because of cap exhaustion
- routing/debug visibility when a token is only temporarily `rate_limited`

Do not require durable event rows for:
- cap exhausted
- cap cleared

Why:
- this is a moving-window state, not a durable lifecycle transition like `maxed`
- routing correctness only needs the current state
- we can still show "why this token is skipped right now" without writing new event history for every threshold crossing

## Data Modeling Recommendation

### Token Config
Extend `in_token_credentials` with:
- `five_hour_reserve_percent`
- `seven_day_reserve_percent`

This keeps operator config cheap to read during routing and analytics.

### Current Provider Usage Snapshot
Add a separate current-snapshot table for provider quota state.

Recommended new table:
- `in_token_credential_provider_usage`

Suggested columns:
- `token_credential_id`
- `org_id`
- `provider`
- `usage_source` (`anthropic_oauth_usage`)
- `five_hour_utilization_ratio`
- `five_hour_resets_at`
- `seven_day_utilization_ratio`
- `seven_day_resets_at`
- `raw_payload`
- `fetched_at`
- `created_at`
- `updated_at`

Why a snapshot table:
- routing reads stay cheap
- analytics can display current state without calling Anthropic live
- raw payload remains available for debugging contract drift

## Polling / Refresh Model
V1 should fetch provider quota state in the background, not on every routing decision.

Recommended shape:
- background job polls all active Claude tokens every `1 minute`
- latest snapshot is written to the current provider usage table
- routing reads only local snapshot state

Staleness rule:
- a snapshot is stale if the latest successful provider-usage fetch for that token is older than `2 minutes`
- plain-language meaning: with a `1 minute` poll cadence, we expected fresh data by now and did not get it

Bootstrap / missing-snapshot rule:
- a token with no successful provider snapshot yet is in `missing_snapshot` state
- this includes new tokens, freshly rotated tokens, and process cold-start before the first successful poll lands
- if either reserve percent is greater than `0`, exclude the Claude token from pooled routing until the first successful snapshot arrives
- if both reserve percents are `0`, allow routing to continue through normal credential-health gates while the first snapshot is pending
- emit an operator-visible warning / ops-log note such as `provider_usage_snapshot_missing`

Stale-data behavior:
- treat stale snapshots as two tiers:
  - soft stale: older than `2 minutes` but not older than `10 minutes`
  - hard stale: older than `10 minutes`
- soft stale behavior:
  - continue using the last successful snapshot for routing
  - emit a warning that is visible in operator-facing logs / ops log
- hard stale behavior:
  - if either reserve percent is greater than `0`, exclude the Claude token from pooled routing until a fresh snapshot arrives
  - if both reserve percents are `0`, fail open and continue using normal credential-health gates
- do not silently bypass reserve enforcement indefinitely because the quota poller is unhealthy

Suggested warning reason:
- `provider_usage_snapshot_stale`

Provider caveat:
- treat `1 minute` as the starting poll cadence, not a guaranteed-safe provider contract
- Anthropic may still rate limit or otherwise reject quota-state fetches
- v1 should canary this against a small Claude-token set first, then widen if fetch health is stable

Fetch-failure behavior:
- if a quota fetch fails, keep the last successful snapshot
- emit an operator-visible warning / ops-log entry such as `provider_usage_fetch_failed`
- if Anthropic returns `429` for the quota endpoint itself, apply simple per-token retry backoff instead of hammering the endpoint
- routing should follow the same soft-stale vs hard-stale policy until a fresh snapshot arrives

## Admin / UX Scope

### Admin Write Surface
Need a way to set and clear per-token reserve percentage without rotating the token.

Recommended admin endpoint:
- `PATCH /v1/admin/token-credentials/:id/contribution-cap`

Suggested request shape:
```json
{
  "fiveHourReservePercent": 20,
  "sevenDayReservePercent": 0
}
```

Suggested semantics:
- `0` means no reserve for that window
- endpoint should not touch monthly contribution fields
- endpoint is Claude-token-safe even if Codex ignores the feature

### Admin Read Surface
Add current fields to token health/dashboard reads:
- `fiveHourReservePercent`
- `fiveHourUtilizationRatio`
- `fiveHourResetsAt`
- `fiveHourContributionCapExhausted`
- `sevenDayReservePercent`
- `sevenDayUtilizationRatio`
- `sevenDayResetsAt`
- `sevenDayContributionCapExhausted`
- `providerUsageFetchedAt`

For non-Claude rows in these dashboard-oriented reads:
- return `null` for all Claude-only contribution-cap / provider-usage fields
- that includes reserve percents, provider utilization fields, reset timestamps, exhausted booleans, and `providerUsageFetchedAt`
- UI can render `0%` only for the `5H CAP` / `7D CAP` table cells as a visual placeholder
- keep the API fields `null` so "not in scope yet" stays distinct from real measured zero

These belong most naturally in:
- `/v1/admin/analytics/tokens/health`
- `/v1/admin/analytics/dashboard`

### Dashboard Table Scope
The token-credentials table in the internal analytics dashboard should add two new operator columns:
- `5H CAP`
- `7D CAP`

Placement:
- immediately to the right of the existing delta column in the token table

Display rule:
- compute these columns in the dashboard layer from raw provider utilization + reserve percentages
- these columns should use normalized cap-used percentages, not raw provider utilization percentages
- this makes `100%` consistently mean "pooled routing is at the limit for this window", whether the limit came from the provider hard ceiling or from a configured reserve
- if the row is a Codex/OpenAI token, show `0%` in both columns for now as a UI placeholder
- no dedicated API fields are required for the table to compute these display values in v1

## Analytics Scope
Add enough visibility to validate and tune the feature.

Need per token:
- configured 5h reserve percent
- configured 7d reserve percent
- current 5h utilization
- current 5h reset time
- current 7d utilization
- current 7d reset time
- whether the token is currently excluded by local contribution cap
- whether the token is currently only transiently `rate_limited`
- how fresh the provider usage snapshot is

Dashboard-derived values:
- normalized `5H CAP` display from raw 5h utilization + 5h reserve
- normalized `7D CAP` display from raw 7d utilization + 7d reserve

Need operator warnings:
- provider usage snapshot stale
- provider usage fetch failed

Recommended operator distinction:
- auth-failure / credential-health maxing
- transient `rate_limited`
- local contribution-cap exhaustion

These should never be merged into one metric.

Important analytics consequence:
- after this change, Claude `maxed` / `reactivated` events should be interpreted as credential-health events, not routine quota-exhaustion events
- Claude quota exhaustion visibility should come from provider-usage fields and current routing skip reasons
- shared summary fields such as `maxedTokens` and `maxedEvents7d` should be treated as credential-health counters, not routine Claude quota-exhaustion counters
- if those shared summary field names remain unchanged, update the API contract and dashboard copy to make that meaning explicit

Legacy empirical Claude fields:
- existing cycle-based fields such as `requestsBeforeMaxedLastWindow`, `avgRequestsBeforeMaxed`, `avgUsageUnitsBeforeMaxed`, `avgRecoveryTimeMs`, `estimatedDailyCapacityUnits`, `maxingCyclesObserved`, and `utilizationRate24h` are no longer authoritative quota/capacity signals for Claude
- provider-reported usage is authoritative for Claude quota state, reserve gating, and cap-progress display
- if those legacy empirical fields remain in Claude read surfaces in v1, label them as legacy credential-health analytics derived from auth-failure `maxed` cycles only
- do not use those legacy empirical fields for Claude routing, reserve enforcement, or primary cap UI

## Implementation Shape

### API / DB
- migration for `five_hour_reserve_percent` and `seven_day_reserve_percent` on token credentials
- migration for current provider-usage snapshot table
- admin endpoint for per-token reserve updates

### Runtime
- Anthropic OAuth usage fetcher for Claude credentials
- background refresh job for current provider quota state every `1 minute`
- poll all active Claude tokens regardless of whether reserve is non-zero
- extend token selection eligibility to respect both 5h and 7d reserve thresholds using local snapshot data
- keep transient Claude `429 -> rate_limited_until` cooldown behavior
- replace Claude `15x 429 -> maxed -> probe` quota recovery with provider-usage-based exclusion and reopen
- on repeated Claude `429` escalation, use longer local backoff instead of `maxed`
- treat tokens with no successful provider snapshot yet according to the documented missing-snapshot bootstrap rule
- keep auth-like `401/403 -> maxed -> probe` lifecycle for Claude
- keep existing non-Claude `maxed` / probe behavior unchanged
- when a token's latest provider-usage snapshot is stale, apply the documented soft-stale vs hard-stale policy and emit an operator-visible warning

### Analytics
- extend analytics repository and route normalization
- add current provider-usage fields to dashboard/token-health payloads
- add `5H CAP` / `7D CAP` columns to the dashboard token table immediately right of delta
- emit `null` for all Claude-only contribution-cap / provider-usage fields on non-Claude rows until that provider family is in scope
- let the UI render `0%` placeholders only for the `5H CAP` / `7D CAP` cells without changing the API meaning
- compute normalized cap-progress display in the dashboard layer from raw utilization + reserve fields
- document Claude legacy empirical maxing/capacity fields as legacy credential-health analytics, not primary quota signals
- add stale/fetch-failure warnings to operator-visible notes / ops log when applicable

### Docs / Contract
- update [docs/API_CONTRACT.md](../API_CONTRACT.md) so Claude `429` handling, `maxed` semantics, and token-health field meanings match this scope
- update [docs/ANALYTICS.md](../ANALYTICS.md) so Claude provider-usage fields are the primary quota/cap signals and legacy empirical cycle fields are clearly marked as legacy credential-health analytics

### Tests
Need coverage for:
- tokens excluded when provider-reported 5h utilization reaches pooled threshold
- tokens excluded when provider-reported 7d utilization reaches pooled threshold
- tokens become eligible again when refreshed provider-reported utilization drops below both active thresholds
- Claude transient `429`s can still set temporary rate-limited cooldown
- Claude repeated `429`s do not auto-`max` or schedule probe for quota exhaustion
- Claude repeated `429`s trigger longer local backoff instead of durable `maxed`
- Claude tokens recover from quota exhaustion via provider refresh, not probe
- Claude auth-failure `maxed` / probe behavior still works
- local cap exhaustion does not set real `maxed`
- local cap exhaustion does not schedule or require probe
- stale provider-usage snapshots follow the documented soft-stale vs hard-stale policy
- tokens with no successful provider snapshot yet follow the documented missing-snapshot bootstrap rule
- reserve `0` behaves as no reserve for each window
- monthly limits and 5h reserve limits compose correctly
- monthly limits, 5h reserves, and 7d reserves compose correctly
- stale snapshots stop enforcing reserve indefinitely only for zero-reserve Claude tokens; reserved Claude tokens are excluded once snapshots become hard-stale
- non-Claude rows return `null` for all Claude-only contribution-cap / provider-usage API fields
- Codex/OpenAI rows render `0%` UI placeholders only in `5H CAP` / `7D CAP`
- Claude provider usage, not legacy empirical maxing-cycle fields, is the authoritative quota/capacity source in the API contract and dashboard semantics
- API_CONTRACT and ANALYTICS docs are updated to match the shipped behavior

## Rollout Plan
1. Land Anthropic usage fetcher and current-snapshot storage.
2. Surface current 5h/7d provider usage in admin analytics/dashboard.
3. Add per-token reserve config endpoint.
4. Ship routing exclusion behind a feature flag.
5. Run shadow-mode validation:
   - compare tokens that would have been locally capped
   - compare old Claude `429 -> maxed` outcomes against provider-usage-based exhaustion decisions
   - verify local capping happens before hard provider maxing when reserve is configured
6. Enable for selected internal Claude tokens first.
7. Revisit polling cadence only if Anthropic usage fetches prove too noisy or expensive.

## Non-Goals
- Codex/OpenAI contribution caps in this scope
- pretending the stored Claude state is universal across providers
- replacing auth-failure `maxed` / probe lifecycle
- removing monthly contribution caps
- introducing a privileged reserve-consumption lane inside Innies in v1

## Definition Of Done
- operators can set both per-token 5-hour and 7-day reserve percentages without rotating the token
- Innies stores current provider-reported 5h and 7d quota state per Claude token
- routing stops assigning pooled traffic to a Claude token once either the shared 5h or shared 7d portion is exhausted
- tokens automatically re-enter routing when refreshed provider-reported 5h and 7d usage recover below threshold
- Claude repeated `429`s no longer drive durable `maxed` / probe recovery for quota exhaustion
- transient Claude `429`s can still temporarily mark a token as `rate_limited`
- auth-failure `maxed` lifecycle remains separate from local contribution-cap exhaustion
- dashboard/admin analytics clearly show reserve %, current 5h/7d usage, reset times, snapshot freshness, and exclusion reason
- dashboard token rows show normalized `5H CAP` and `7D CAP` percentages against the effective shared cap
- quota polling failures and stale snapshots are visible in the ops log without incorrectly hard-disabling tokens
