# Analytics

## Short Answer

### Yes, we are storing the raw historical data needed for empirical OAuth-token analytics later.

Stored now:
- routing attempts over time
- usage per attempt over time
- token lifecycle events over time (`maxed`, `reactivated`, `probe_failed`, `paused`, `unpaused`)
- current token state and current manual monthly budget state

That means we can derive later:
- burn per OAuth token over time
- burn until maxed
- requests until maxed
- recovery time
- empirical capacity estimates
- historical empirical utilization charts

### Partially: we now store live Claude provider-usage snapshots, but not snapshot history.

Stored now for Claude OAuth tokens:
- provider-reported `5h` utilization ratio
- provider-reported `7d` utilization ratio
- provider-reported reset timestamps for both windows
- latest fetch timestamp per token

Not stored now:
- provider-declared absolute quota ceilings
- provider-declared remaining units
- historical snapshot series over time

That means we can now:
- enforce live per-token `5h` and `7d` reserves for pooled Claude routing
- show current quota/reset state per Claude token in admin analytics

That means we still cannot derive later from storage alone:
- true historical provider quota charts
- exact provider-declared remaining-unit burn curves over time

### Current Claude quota fields

The admin analytics read surface now carries these Claude quota fields:
- `fiveHourReservePercent`
- `fiveHourUtilizationRatio`
- `fiveHourResetsAt`
- `fiveHourContributionCapExhausted`
- `sevenDayReservePercent`
- `sevenDayUtilizationRatio`
- `sevenDayResetsAt`
- `sevenDayContributionCapExhausted`
- `providerUsageFetchedAt`
- `claudeFiveHourCapExhaustionCyclesObserved`
- `claudeFiveHourUsageUnitsBeforeCapExhaustionLastWindow`
- `claudeFiveHourAvgUsageUnitsBeforeCapExhaustion`
- `claudeSevenDayCapExhaustionCyclesObserved`
- `claudeSevenDayUsageUnitsBeforeCapExhaustionLastWindow`
- `claudeSevenDayAvgUsageUnitsBeforeCapExhaustion`

Current expectation:
- OpenAI/Codex rows may populate the raw provider-usage snapshot fields (`fiveHourUtilizationRatio`, `fiveHourResetsAt`, `sevenDayUtilizationRatio`, `sevenDayResetsAt`, `providerUsageFetchedAt`) when a stored snapshot exists
- non-Claude reserve / contribution-cap fields still keep `null`
- Claude rows may still keep them `null` when the latest usage snapshot is missing or analytics is reading against a pre-migration environment
- the dashboard shows raw provider usage in `5H` / `7D`; Claude rows tint exhausted cells when a reserve or provider limit is hit, while OpenAI/Codex rows use those windows for derived usage-exhausted status without reserve semantics
- the Claude cap-cycle usage fields are derived from durable `contribution_cap_exhausted` / `contribution_cap_cleared` events plus usage-ledger sums between the prior clear point and each exhaustion point

## What We Actually Store

- `in_routing_events`
  - one row per routing attempt
  - includes provider, model, source, token credential used, fallback metadata, upstream status, latency, TTFB

- `in_usage_ledger`
  - one row per usage write
  - includes input tokens, output tokens, `usage_units`, retail-equivalent cost

- `in_token_credential_events`
  - durable lifecycle history
  - currently: `maxed`, `reactivated`, `probe_failed`, `contribution_cap_exhausted`, `contribution_cap_cleared`, `paused`, `unpaused`

- `in_token_credentials`
  - current token state
  - includes current manual monthly contribution limit/used/window fields

- `in_request_log`
  - successful request previews only
  - prompt/response previews, not full public body archival

- `in_daily_aggregates`
  - daily rolled-up usage windows
  - mainly used for anomaly checks

## What The Current API Gives You

- `/tokens`
  - per OAuth token burn totals
  - safe display ids plus attempt vs distinct-request counts

- `/tokens/health`
  - current token state
  - current manual monthly budget usage
  - exact `maxedEvents7d`
  - empirical maxing / recovery / capacity / utilization metrics when enough history exists
  - live provider-usage snapshot fields when a stored snapshot exists; reserve / contribution-cap flags remain Claude-only
  - Claude 5h / 7d usage-units-before-cap-exhaustion metrics when those cap cycles have been observed
  - best-effort auth diagnosis fields when Innies can derive them (`authDiagnosis`, `accessTokenExpiresAt`, `refreshTokenState`)

- `/tokens/routing`
  - per-token routing quality, fallbacks, latency, TTFB

- `/system`
  - provider-level usage totals
  - request volume
  - top buyers
  - system-wide latency / error / fallback metrics
  - current usage-maxed token count in `maxedTokens`, including active OpenAI/Codex rows whose stored provider-usage window is exhausted

- `/timeseries`
  - request / usage / error / latency over time
  - supports `5h` windows and sub-hour `5m|15m` buckets

- `/buyers`
  - full buyer-key inventory analytics
  - includes zero-usage buyer keys
  - effective provider, last seen, source mix, error rate

- `/buyers/timeseries`
  - buyer-key chart series over time
  - request / usage / error / latency buckets per buyer
  - multi-buyer fan-in via repeated `apiKeyId`

- `/requests`
  - recent request drilldown with previews
  - attempt-level rows with `attemptNo`

- `/events`
  - token lifecycle event feed
  - currently durable `maxed|reactivated|probe_failed|contribution_cap_exhausted|contribution_cap_cleared|paused|unpaused` reads

- `/dashboard`
  - one merged snapshot for summary + tokens + buyers + anomalies + events
  - shared snapshot cache keyed by `window/provider/source`, refreshed at most once every ~2.5s per key
  - keeps the admin dashboard feeling live without recomputing the heaviest buyer/token-health queries for every tab
  - carries raw provider-usage snapshot fields when available; reserve / contribution-cap flags remain Claude-only
  - derives `5H` / `7D` in the dashboard layer
  - renders raw `5H` / `7D` percentages for both Claude and OpenAI/Codex rows when usage-window telemetry exists; exhausted windows highlight red, while Claude reserve/cap flags can also trigger that highlight
  - surfaces provider-usage freshness and exhaustion warnings in the snapshot `warnings` list
  - distinguishes backend auth parking (`backend_maxed`) from derived usage exhaustion (`cap_exhausted` for Claude, `usage_exhausted` for OpenAI/Codex)

- `/anomalies`
  - aggregate staleness / mismatch and attribution checks

## Important Boundary

If the question is:

- "Can we build good empirical token analytics from what we store now?"
  - yes

- "Can we build true provider quota analytics from what we store now?"
  - partially
  - we can drive current-state reserve enforcement and current-token quota visibility
  - we still cannot reconstruct historical provider quota usage over time
