# Analytics Validation

## Purpose
Durable Agent 3 handoff for Phase 1 feature `3) Per-token analytics gathering`.

Use this after the analytics route/repository work lands to:
- cross-check endpoint output against raw SQL
- verify source classification semantics
- trace one token-mode request end-to-end
- hand clean endpoint ownership to the Phase 1 dashboard work

## Preconditions
- `api/src/routes/analytics.ts` is landed and mounted
- analytics repository/query methods are landed
- exact durable source for `maxedEvents7d` is landed
- `ttfb_ms` persistence is landed where the contract requires it
- `in_request_log` exists before validating `/v1/admin/analytics/requests`

Pending implementation in the current contract:
- `translationOverhead`
- `requestsBeforeMaxedLastWindow`
- `utilizationRate24h`
- `staleAggregateWindows`
- `usageLedgerVsAggregateMismatchCount`

Current API expectation for those fields: return `null`, not `0`.

## Shared SQL Base
Use current table names from `api/src/repos/tableNames.ts`.

```sql
with routing_scoped as (
  select
    re.org_id,
    re.api_key_id,
    re.request_id,
    re.attempt_no,
    re.provider,
    re.model,
    re.upstream_status,
    re.error_code,
    re.latency_ms,
    re.ttfb_ms,
    re.route_decision,
    re.route_decision->>'tokenCredentialId' as credential_id,
    re.route_decision->>'tokenCredentialLabel' as credential_label,
    nullif(re.route_decision->>'request_source', '') as request_source,
    re.route_decision->>'provider_selection_reason' as provider_selection_reason,
    re.route_decision->>'openclaw_run_id' as openclaw_run_id,
    coalesce((re.route_decision->>'translated')::boolean, false) as translated,
    re.created_at,
    case
      when nullif(re.route_decision->>'request_source', '') is not null then re.route_decision->>'request_source'
      when re.route_decision->>'provider_selection_reason' = 'cli_provider_pinned' and re.provider = 'anthropic' then 'cli-claude'
      when re.route_decision->>'provider_selection_reason' = 'cli_provider_pinned' and re.provider = 'openai' then 'cli-codex'
      when nullif(re.route_decision->>'openclaw_run_id', '') is not null then 'openclaw'
      else 'direct'
    end as source
  from in_routing_events re
  where (
    :window = 'all'
    or re.created_at >= case
      when :window = '24h' then now() - interval '24 hours'
      when :window = '7d' then now() - interval '7 days'
      when :window = '1m' then now() - interval '30 days'
      else now() - interval '24 hours'
    end
  )
  and (:provider is null or re.provider = :provider)
),
usage_scoped as (
  select
    ul.org_id,
    ul.api_key_id,
    ul.request_id,
    ul.attempt_no,
    ul.seller_key_id,
    ul.provider,
    ul.model,
    ul.input_tokens,
    ul.output_tokens,
    ul.usage_units,
    ul.retail_equivalent_minor,
    ul.created_at
  from in_usage_ledger ul
  where ul.entry_type = 'usage'
  and (
    :window = 'all'
    or ul.created_at >= case
      when :window = '24h' then now() - interval '24 hours'
      when :window = '7d' then now() - interval '7 days'
      when :window = '1m' then now() - interval '30 days'
      else now() - interval '24 hours'
    end
  )
),
token_joined as (
  select
    rs.*, 
    us.seller_key_id,
    us.input_tokens,
    us.output_tokens,
    us.usage_units,
    us.retail_equivalent_minor
  from routing_scoped rs
  left join usage_scoped us
    on us.org_id = rs.org_id
   and us.request_id = rs.request_id
   and us.attempt_no = rs.attempt_no
)
```

## Endpoint SQL Checks

### `GET /v1/admin/analytics/tokens`
```sql
with ...
select
  tj.credential_id,
  tc.debug_label,
  tc.provider,
  tc.status,
  tj.source,
  count(*) filter (where tj.credential_id is not null) as requests,
  coalesce(sum(tj.usage_units), 0) as usage_units,
  coalesce(sum(tj.retail_equivalent_minor), 0) as retail_equivalent_minor,
  coalesce(sum(tj.input_tokens), 0) as input_tokens,
  coalesce(sum(tj.output_tokens), 0) as output_tokens
from token_joined tj
join in_token_credentials tc on tc.id::text = tj.credential_id
where (:source is null or tj.source = :source)
group by 1,2,3,4,5
order by tc.provider, tc.debug_label nulls last, tj.credential_id, tj.source;
```

Expectations:
- token-mode rows resolve via `route_decision->>'tokenCredentialId'`
- `seller_key_id` is never used as the token analytics identity
- endpoint `bySource` totals re-sum to the per-token top line

### `GET /v1/admin/analytics/tokens/health`
```sql
select
  tc.id as credential_id,
  tc.debug_label,
  tc.provider,
  tc.status,
  tc.consecutive_failure_count,
  tc.last_failed_status,
  tc.last_failed_at,
  tc.maxed_at,
  tc.next_probe_at,
  tc.last_probe_at,
  tc.monthly_contribution_limit_units,
  tc.monthly_contribution_used_units,
  tc.monthly_window_start_at,
  tc.created_at,
  tc.expires_at
from in_token_credentials tc
where (:provider is null or tc.provider = :provider)
order by tc.provider, tc.debug_label nulls last, tc.id;
```

Exact `maxedEvents7d` check:
- validate against the durable transition source Agent 1 lands
- do not infer exact event count from current-state `maxed_at` alone

Pending implementation:
- `requestsBeforeMaxedLastWindow` should stay `null` until paired maxed-event analysis exists
- `utilizationRate24h` should stay `null` until actual 24h usage can be compared against a real capacity estimate

### `GET /v1/admin/analytics/tokens/routing`
```sql
with ...
select
  tj.credential_id,
  max(tj.credential_label) as credential_label,
  max(tj.provider) as provider,
  count(*) as total_attempts,
  count(*) filter (where tj.upstream_status between 200 and 299) as success_count,
  count(*) filter (where tj.upstream_status is null or tj.upstream_status < 200 or tj.upstream_status >= 300) as error_count,
  count(*) filter (where tj.upstream_status in (401, 403)) as auth_failures,
  count(*) filter (where tj.upstream_status = 429) as rate_limited,
  count(*) filter (where tj.provider_selection_reason = 'fallback_provider_selected') as fallback_count,
  percentile_disc(0.5) within group (order by tj.latency_ms) as latency_p50_ms,
  percentile_disc(0.95) within group (order by tj.latency_ms) as latency_p95_ms,
  percentile_disc(0.5) within group (order by tj.ttfb_ms) as ttfb_p50_ms,
  percentile_disc(0.95) within group (order by tj.ttfb_ms) as ttfb_p95_ms
from token_joined tj
where tj.credential_id is not null
and (:source is null or tj.source = :source)
group by tj.credential_id
order by provider, credential_label nulls last, tj.credential_id;
```

### `GET /v1/admin/analytics/system`
```sql
with ...
select
  count(distinct tj.request_id) as total_requests,
  coalesce(sum(tj.usage_units), 0) as total_usage_units,
  percentile_disc(0.5) within group (order by tj.latency_ms) as latency_p50_ms,
  percentile_disc(0.95) within group (order by tj.latency_ms) as latency_p95_ms,
  percentile_disc(0.5) within group (order by tj.ttfb_ms) as ttfb_p50_ms,
  percentile_disc(0.95) within group (order by tj.ttfb_ms) as ttfb_p95_ms,
  count(*) filter (where tj.upstream_status is null or tj.upstream_status < 200 or tj.upstream_status >= 300)::numeric / nullif(count(*), 0) as error_rate,
  count(*) filter (where tj.provider_selection_reason = 'fallback_provider_selected')::numeric / nullif(count(*), 0) as fallback_rate,
  count(*) filter (where tj.translated) as translated_request_count,
  count(*) filter (where not tj.translated) as direct_request_count
from token_joined tj
where (:source is null or tj.source = :source);
```

Additional checks:
- `byProvider` and `bySource` should re-sum to the system total
- top buyers should be ranked from usage rows joined on `api_key_id`

Pending implementation:
- `translationOverhead` validation is blocked on durable translated-request attribution; current contract expects `null`

### `GET /v1/admin/analytics/timeseries`
```sql
with ...
select
  case
    when :granularity = 'hour' then date_trunc('hour', tj.created_at)
    else date_trunc('day', tj.created_at)
  end as bucket,
  count(distinct tj.request_id) as requests,
  coalesce(sum(tj.usage_units), 0) as usage_units,
  count(*) filter (where tj.upstream_status is null or tj.upstream_status < 200 or tj.upstream_status >= 300)::numeric / nullif(count(*), 0) as error_rate,
  percentile_disc(0.5) within group (order by tj.latency_ms) as latency_p50_ms
from token_joined tj
where (:source is null or tj.source = :source)
and (:credential_id is null or tj.credential_id = :credential_id)
group by 1
order by 1;
```

### `GET /v1/admin/analytics/requests`
```sql
with ...
select
  tj.request_id,
  tj.created_at,
  tj.credential_id,
  tj.credential_label,
  tj.provider,
  tj.model,
  tj.source,
  tj.translated,
  tj.upstream_status,
  tj.latency_ms,
  tj.ttfb_ms,
  tj.input_tokens,
  tj.output_tokens,
  tj.usage_units,
  rl.prompt_preview,
  rl.response_preview
from token_joined tj
left join in_request_log rl
  on rl.org_id = tj.org_id
 and rl.request_id = tj.request_id
 and rl.attempt_no = tj.attempt_no
where (:source is null or tj.source = :source)
and (:credential_id is null or tj.credential_id = :credential_id)
and (:model is null or tj.model = :model)
and (:min_latency_ms is null or tj.latency_ms >= :min_latency_ms)
order by tj.created_at desc
limit :limit;
```

Checks:
- preview fields are truncated in storage and response
- no full encrypted content is returned by default
- `REQUEST_LOG_STORE_FULL` is not yet wired; do not treat full-content storage as a Phase 1 requirement

### `GET /v1/admin/analytics/anomalies`
```sql
with ...
select
  (select count(*) from in_token_credentials where nullif(trim(coalesce(debug_label, '')), '') is null) as missing_debug_labels,
  (
    select count(*)
    from token_joined
    where credential_id is null
      and seller_key_id is null
  ) as unresolved_credential_ids_in_token_mode_usage,
  (
    select count(*)
    from routing_scoped
    where credential_id is null
  ) as null_credential_ids_in_routing;
```

Pending implementation:
- `staleAggregateWindows` should stay `null` until the stale-aggregate recency check lands
- `usageLedgerVsAggregateMismatchCount` should stay `null` until the raw-vs-aggregate comparison lands

## End-to-End Token-Mode Trace
1. Issue one token-mode request and capture response headers:
   - `x-request-id`
   - `x-innies-token-credential-id`
2. Query `in_routing_events` by `(org_id, request_id)` and confirm:
   - `route_decision->>'tokenCredentialId'`
   - `route_decision->>'request_source'`
   - `provider_selection_reason`
   - `openclaw_run_id`
3. Query `in_usage_ledger` by `(org_id, request_id, attempt_no)` and confirm metering row presence.
4. If request logging is enabled, query `in_request_log` by `(org_id, request_id, attempt_no)` and confirm preview truncation.
5. Hit the analytics endpoint row that should contain the credential and confirm counts/latency/source match the raw rows.

## Dashboard Consumer Mapping
- `/v1/admin/analytics/tokens` -> per-token throughput and usage cards
- `/v1/admin/analytics/tokens/health` -> token health and maxed panels (`utilizationRate24h` / recovery-derived metrics remain deferred)
- `/v1/admin/analytics/tokens/routing` -> latency/error/fallback grid per credential
- `/v1/admin/analytics/system` -> global overview, provider mix, source mix, top buyers
- `/v1/admin/analytics/timeseries` -> day/hour charts for traffic, usage, error rate, latency
- `/v1/admin/analytics/requests` -> drill-down/debug table for recent requests
- `/v1/admin/analytics/anomalies` -> dashboard confidence badge and operator warning strip

## Phase 1 Blockers To Close
- analytics route/repository code is not yet present on `main`
- route auth/validation tests depend on the missing route surface
- exact `maxedEvents7d` cannot ship until a durable transition source exists
- `ttfb_ms` must be persisted in the routing table before TTFB endpoint checks are authoritative
- `/requests` depends on `in_request_log` and retention cleanup landing
- real-data SQL cross-check still needs to be run in an environment with production-like data
