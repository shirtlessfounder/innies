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
with credential_base as (
  select
    tc.id,
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
),
maxed_cycles as (
  select
    cb.id::text as credential_id,
    me.created_at as maxed_at,
    coalesce(
      (
        select re.created_at
        from in_token_credential_events re
        where re.token_credential_id = me.token_credential_id
          and re.event_type = 'reactivated'
          and re.created_at < me.created_at
        order by re.created_at desc
        limit 1
      ),
      cb.created_at
    ) as cycle_start_at,
    (
      select re.created_at
      from in_token_credential_events re
      where re.token_credential_id = me.token_credential_id
        and re.event_type = 'reactivated'
        and re.created_at > me.created_at
      order by re.created_at asc
      limit 1
    ) as reactivated_at
  from credential_base cb
  join in_token_credential_events me
    on me.token_credential_id = cb.id
   and me.event_type = 'maxed'
),
cycle_rollups as (
  select
    mc.credential_id,
    mc.maxed_at,
    mc.reactivated_at,
    count(distinct re.request_id) as request_count,
    coalesce(sum(ul.usage_units), 0) as usage_units,
    extract(epoch from (mc.maxed_at - mc.cycle_start_at)) / 86400.0 as cycle_duration_days
  from maxed_cycles mc
  left join in_routing_events re
    on re.route_decision->>'tokenCredentialId' = mc.credential_id
   and re.created_at >= mc.cycle_start_at
   and re.created_at <= mc.maxed_at
  left join in_usage_ledger ul
    on ul.org_id = re.org_id
   and ul.request_id = re.request_id
   and ul.attempt_no = re.attempt_no
   and ul.entry_type = 'usage'
  group by 1,2,3
)
select ...
from credential_base cb
left join cycle_rollups cr on cr.credential_id = cb.id::text;
```

Expectations:
- `maxedEvents7d` validates against `in_token_credential_events`, not current-state `maxed_at`
- maxed-cycle metrics anchor on `maxed_at`; `avgRecoveryTimeMs` anchors on `reactivated_at`
- `source` is accepted by the route layer but ignored by the health query
- `estimatedDailyCapacityUnits` is the `p50` of per-cycle `usage_units / cycle_duration_days` and stays `null` unless at least 2 valid cycles exist
- `utilizationRate24h` is trailing 24h credential-attributed usage divided by `estimatedDailyCapacityUnits`; it may exceed `1`
- `maxingCyclesObserved` stays numeric and becomes `0` when no maxed cycles are present in-window

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
  ) as null_credential_ids_in_routing,
  (
    with raw_windows as (
      select
        date_trunc('day', ul.created_at)::date as day,
        ul.org_id,
        ul.seller_key_id,
        ul.provider,
        ul.model,
        max(ul.created_at) as latest_raw_at
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
        and (:provider is null or ul.provider = :provider)
      group by 1,2,3,4,5
    )
    select count(*)
    from raw_windows rw
    left join in_daily_aggregates da
      on da.day = rw.day
     and da.org_id = rw.org_id
     and da.seller_key_id is not distinct from rw.seller_key_id
     and da.provider = rw.provider
     and da.model = rw.model
    where now() >= case
      when rw.day = (now() at time zone 'utc')::date
        then rw.latest_raw_at + interval '20 minutes'
      else greatest(
        rw.latest_raw_at + interval '20 minutes',
        (((rw.day + 1)::timestamp at time zone 'utc') + interval '2 hours')
      )
    end
      and (
        da.updated_at is null
        or da.updated_at < rw.latest_raw_at
      )
  ) as stale_aggregate_windows,
  (
    with candidate_days as (
      select distinct day
      from (
        select distinct date_trunc('day', ul.created_at)::date as day
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
          and (:provider is null or ul.provider = :provider)
        union
        select distinct da.day
        from in_daily_aggregates da
        where (
          :window = 'all'
          or da.day >= case
            when :window = '24h' then ((now() at time zone 'utc') - interval '24 hours')::date
            when :window = '7d' then ((now() at time zone 'utc') - interval '7 days')::date
            when :window = '1m' then ((now() at time zone 'utc') - interval '30 days')::date
            else ((now() at time zone 'utc') - interval '24 hours')::date
          end
        )
          and (:provider is null or da.provider = :provider)
      ) candidate_day_union
    ),
    closed_candidate_days as (
      select day
      from candidate_days
      where day < (now() at time zone 'utc')::date
    ),
    raw_windows as (
      select
        date_trunc('day', ul.created_at)::date as day,
        ul.org_id,
        ul.seller_key_id,
        ul.provider,
        ul.model,
        count(*) as requests_count,
        coalesce(sum(ul.usage_units), 0) as usage_units,
        coalesce(sum(ul.retail_equivalent_minor), 0) as retail_equivalent_minor
      from in_usage_ledger ul
      where ul.entry_type = 'usage'
        and date_trunc('day', ul.created_at)::date in (select day from closed_candidate_days)
        and (:provider is null or ul.provider = :provider)
      group by 1,2,3,4,5
    ),
    aggregate_windows as (
      select
        da.day,
        da.org_id,
        da.seller_key_id,
        da.provider,
        da.model,
        da.requests_count,
        da.usage_units,
        da.retail_equivalent_minor
      from in_daily_aggregates da
      where da.day in (select day from closed_candidate_days)
        and (:provider is null or da.provider = :provider)
    )
    select count(*)
    from raw_windows rw
    full outer join aggregate_windows aw
      on aw.day = rw.day
     and aw.org_id = rw.org_id
     and aw.seller_key_id is not distinct from rw.seller_key_id
     and aw.provider = rw.provider
     and aw.model = rw.model
    where rw.requests_count is distinct from aw.requests_count
       or rw.usage_units is distinct from aw.usage_units
       or rw.retail_equivalent_minor is distinct from aw.retail_equivalent_minor
  ) as usage_ledger_vs_aggregate_mismatch_count;
```

Checks:
- aggregate anomaly checks honor `provider` but ignore `source`
- mismatch checks only compare closed UTC days
- both checks use raw rows where `entry_type = 'usage'`
- stale checks only fire once the raw window is past its refresh SLA and the aggregate row is still older than the latest raw row
- mismatch checks include aggregate-only closed days, not just days discovered from raw usage

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
- `/v1/admin/analytics/tokens/health` -> token health and maxed panels
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
