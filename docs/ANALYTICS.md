# Analytics

## Short Answer

### Yes, we are storing the raw historical data needed for empirical OAuth-token analytics later.

Stored now:
- routing attempts over time
- usage per attempt over time
- token lifecycle events over time (`maxed`, `reactivated`, `probe_failed`)
- current token state and current manual monthly budget state

That means we can derive later:
- burn per OAuth token over time
- burn until maxed
- requests until maxed
- recovery time
- empirical capacity estimates
- historical empirical utilization charts

### No, we are not storing the raw data needed for true provider-set quota analytics.

Not stored now:
- provider-reported quota limits
- provider-reported remaining quota
- provider reset timestamps / provider quota-window headers

That means we cannot derive later:
- true provider-declared daily / weekly / 5h quota usage
- true remaining provider quota per OAuth token
- true provider reset-window charts

## What We Actually Store

- `in_routing_events`
  - one row per routing attempt
  - includes provider, model, source, token credential used, fallback metadata, upstream status, latency, TTFB

- `in_usage_ledger`
  - one row per usage write
  - includes input tokens, output tokens, `usage_units`, retail-equivalent cost

- `in_token_credential_events`
  - durable lifecycle history
  - currently: `maxed`, `reactivated`, `probe_failed`

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

- `/tokens/health`
  - current token state
  - current manual monthly budget usage
  - exact `maxedEvents7d`
  - empirical maxing / recovery / capacity / utilization metrics when enough history exists

- `/tokens/routing`
  - per-token routing quality, fallbacks, latency, TTFB

- `/system`
  - provider-level usage totals
  - request volume
  - top buyers
  - system-wide latency / error / fallback metrics

- `/timeseries`
  - request / usage / error / latency over time

- `/requests`
  - recent request drilldown with previews

- `/anomalies`
  - aggregate staleness / mismatch and attribution checks

## Important Boundary

If the question is:

- "Can we build good empirical token analytics from what we store now?"
  - yes

- "Can we build true provider quota analytics from what we store now?"
  - no
