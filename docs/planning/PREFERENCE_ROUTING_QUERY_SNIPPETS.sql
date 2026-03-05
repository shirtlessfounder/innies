-- Provider Preference Debug Queries (Agent 3)
-- Replace placeholders: :ORG_ID, :SINCE_TS, :SESSION_ID

-- 1) Recent routing attempts with current preference metadata fields
select
  request_id,
  attempt_no,
  provider,
  model,
  upstream_status,
  error_code,
  route_decision->>'reason' as selection_reason,
  route_decision->>'provider_selection_reason' as provider_selection_reason,
  route_decision->>'provider_preferred' as provider_preferred,
  route_decision->>'provider_effective' as provider_effective,
  route_decision->>'provider_fallback_from' as provider_fallback_from,
  route_decision->>'provider_fallback_reason' as provider_fallback_reason,
  route_decision->>'provider_plan' as provider_plan,
  created_at
from in_routing_events
where org_id = :'ORG_ID'
  and created_at >= :'SINCE_TS'::timestamptz
order by created_at desc, request_id, attempt_no;

-- 2) Requests that crossed providers (fallback indicator)
with req_providers as (
  select
    request_id,
    count(distinct provider) as provider_count,
    min(created_at) as first_seen_at,
    max(created_at) as last_seen_at
  from in_routing_events
  where org_id = :'ORG_ID'
    and created_at >= :'SINCE_TS'::timestamptz
  group by request_id
)
select *
from req_providers
where provider_count > 1
order by last_seen_at desc;

-- 3) Extract current selection + fallback fields from route_decision JSON
select
  request_id,
  attempt_no,
  provider,
  route_decision->>'reason' as selection_reason,
  route_decision->>'provider_selection_reason' as provider_selection_reason,
  route_decision->>'provider_preferred' as provider_preferred,
  route_decision->>'provider_effective' as provider_effective,
  route_decision->>'provider_fallback_from' as provider_fallback_from,
  route_decision->>'provider_fallback_reason' as provider_fallback_reason,
  route_decision->>'provider_plan' as provider_plan,
  created_at
from in_routing_events
where org_id = :'ORG_ID'
  and created_at >= :'SINCE_TS'::timestamptz
order by created_at desc, request_id, attempt_no;

-- 4) Requests that exercised preference metadata
select
  request_id,
  attempt_no,
  provider,
  route_decision->>'reason' as selection_reason,
  route_decision->>'provider_preferred' as provider_preferred,
  route_decision->>'provider_effective' as provider_effective,
  route_decision->>'provider_plan' as provider_plan,
  created_at
from in_routing_events
where org_id = :'ORG_ID'
  and created_at >= :'SINCE_TS'::timestamptz
  and route_decision ? 'provider_preferred'
order by created_at desc, request_id, attempt_no;

-- 5) CLI/session no-provider-flip guard (expects exactly one provider per session)
select
  route_decision->>'openclaw_session_id' as session_id,
  count(*) as events,
  count(distinct provider) as distinct_providers,
  array_agg(distinct route_decision->>'provider_selection_reason' order by route_decision->>'provider_selection_reason') as selection_reasons,
  array_agg(distinct provider order by provider) as providers
from in_routing_events
where org_id = :'ORG_ID'
  and created_at >= :'SINCE_TS'::timestamptz
  and nullif(route_decision->>'openclaw_session_id', '') is not null
group by 1
order by max(created_at) desc;

-- 6) Deep dive for one session
select
  request_id,
  attempt_no,
  provider,
  route_decision,
  upstream_status,
  error_code,
  created_at
from in_routing_events
where org_id = :'ORG_ID'
  and route_decision->>'openclaw_session_id' = :'SESSION_ID'
order by created_at asc, request_id, attempt_no;

-- 7) Rows missing a session id (diagnostic only)
select
  request_id,
  attempt_no,
  provider,
  route_decision->>'provider_selection_reason' as provider_selection_reason,
  created_at
from in_routing_events
where org_id = :'ORG_ID'
  and created_at >= :'SINCE_TS'::timestamptz
  and nullif(route_decision->>'openclaw_session_id', '') is null
order by created_at desc, request_id, attempt_no;
