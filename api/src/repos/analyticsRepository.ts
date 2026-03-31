import type { SqlClient, SqlValue } from './sqlClient.js';
import { TABLES } from './tableNames.js';
import type { AnalyticsRouteRepository } from '../routes/analytics.js';
import { decryptSecret } from '../utils/crypto.js';
import { deriveTokenCredentialAuthDiagnosis } from '../services/tokenCredentialAuthDiagnosis.js';
import { resolveDefaultBuyerProvider } from '../utils/providerPreference.js';

type AnalyticsWindow = '5h' | '24h' | '7d' | '1m' | 'all';
type AnalyticsGranularity = '5m' | '15m' | 'hour' | 'day';

type BaseFilters = {
  window: AnalyticsWindow;
  provider?: string;
  source?: string;
  orgId?: string;
};

type BuyerTimeSeriesFilters = BaseFilters & {
  granularity: AnalyticsGranularity;
  apiKeyIds?: string[];
};

type EventFilters = {
  window: AnalyticsWindow;
  provider?: string;
  limit: number;
  orgId?: string;
};

type RecentRequestCursor = {
  createdAt: string;
  requestId: string;
  attemptNo: number;
};

type CapHistoryCursor = {
  exhaustedAt: string;
  credentialId: string;
  windowKind: string;
  eventId: string;
};

type SessionCursor = {
  lastActivityAt: string;
  sessionKey: string;
};

function windowSql(window: AnalyticsWindow, alias = 're'): string {
  switch (window) {
    case '5h':  return `${alias}.created_at >= now() - interval '5 hours'`;
    case '24h': return `${alias}.created_at >= now() - interval '24 hours'`;
    case '7d':  return `${alias}.created_at >= now() - interval '7 days'`;
    case '1m':  return `${alias}.created_at >= now() - interval '30 days'`;
    case 'all': return '1=1';
    default:    return '1=1';
  }
}

function windowSqlRaw(window: AnalyticsWindow, col = 'created_at'): string {
  switch (window) {
    case '5h':  return `${col} >= now() - interval '5 hours'`;
    case '24h': return `${col} >= now() - interval '24 hours'`;
    case '7d':  return `${col} >= now() - interval '7 days'`;
    case '1m':  return `${col} >= now() - interval '30 days'`;
    case 'all': return '1=1';
    default:    return '1=1';
  }
}

function dayWindowSql(window: AnalyticsWindow, col = 'day'): string {
  switch (window) {
    case '5h':  return `${col} >= ((now() at time zone 'utc') - interval '5 hours')::date`;
    case '24h': return `${col} >= ((now() at time zone 'utc') - interval '24 hours')::date`;
    case '7d':  return `${col} >= ((now() at time zone 'utc') - interval '7 days')::date`;
    case '1m':  return `${col} >= ((now() at time zone 'utc') - interval '30 days')::date`;
    case 'all': return '1=1';
    default:    return '1=1';
  }
}

function dayWindowStartSql(window: AnalyticsWindow): string {
  switch (window) {
    case '5h':  return "((now() at time zone 'utc') - interval '5 hours')::date";
    case '24h': return "((now() at time zone 'utc') - interval '24 hours')::date";
    case '7d':  return "((now() at time zone 'utc') - interval '7 days')::date";
    case '1m':  return "((now() at time zone 'utc') - interval '30 days')::date";
    case 'all': return "((now() at time zone 'utc') - interval '30 days')::date";
    default:    return "((now() at time zone 'utc') - interval '30 days')::date";
  }
}

function windowStartTimestampSql(window: AnalyticsWindow): string {
  switch (window) {
    case '5h':  return "now() - interval '5 hours'";
    case '24h': return "now() - interval '24 hours'";
    case '7d':  return "now() - interval '7 days'";
    case '1m':  return "now() - interval '30 days'";
    case 'all': return "now() - interval '30 days'";
    default:    return "now() - interval '30 days'";
  }
}

function usageDaySql(alias = 'ul'): string {
  return `(${alias}.created_at at time zone 'utc')::date`;
}

function closedAggregateRefreshDeadlineSql(dayExpr: string): string {
  return `(((${dayExpr} + 1)::timestamp at time zone 'utc') + interval '2 hours')`;
}

function timeBucketSql(granularity: AnalyticsGranularity, col = 're.created_at'): string {
  switch (granularity) {
    case '5m':
      return `to_timestamp(floor(extract(epoch from ${col}) / 300) * 300)`;
    case '15m':
      return `to_timestamp(floor(extract(epoch from ${col}) / 900) * 900)`;
    case 'hour':
      return `date_trunc('hour', ${col})`;
    case 'day':
    default:
      return `date_trunc('day', ${col})`;
  }
}

const SOURCE_CASE = `
  coalesce(
    nullif(re.route_decision->>'request_source', ''),
    CASE
      WHEN re.route_decision->>'provider_selection_reason' = 'cli_provider_pinned'
        AND re.provider = 'openai' THEN 'cli-codex'
      WHEN re.route_decision->>'provider_selection_reason' = 'cli_provider_pinned'
        AND re.provider != 'openai' THEN 'cli-claude'
      WHEN re.route_decision->>'openclaw_run_id' IS NOT NULL THEN 'openclaw'
      ELSE 'direct'
    END
  )
`;

function applyBaseFilters(
  where: string[],
  params: SqlValue[],
  filters: BaseFilters,
  alias = 're'
): void {
  where.push(windowSql(filters.window, alias));

  if (filters.provider) {
    params.push(filters.provider);
    where.push(`${alias}.provider = $${params.length}`);
  }

  if (filters.source) {
    params.push(filters.source);
    where.push(`(${SOURCE_CASE}) = $${params.length}`);
  }

  if (filters.orgId) {
    params.push(filters.orgId);
    where.push(`${alias}.org_id = $${params.length}`);
  }
}

function applyOrgIdFilter(
  where: string[],
  params: SqlValue[],
  orgId: string | undefined,
  column: string
): void {
  if (!orgId) return;
  params.push(orgId);
  where.push(`${column} = $${params.length}`);
}

function applyCanonicalCredentialProviderFilter(
  where: string[],
  params: SqlValue[],
  provider: string | undefined,
  column: string
): void {
  if (!provider) return;

  if (provider === 'openai') {
    params.push(['openai', 'codex']);
    where.push(`${column} = ANY($${params.length}::text[])`);
    return;
  }

  params.push(provider);
  where.push(`${column} = $${params.length}`);
}

function decodeRecentRequestCursor(cursor: string | undefined): RecentRequestCursor | null {
  if (!cursor) return null;

  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
  const createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : null;
  const requestId = typeof parsed.requestId === 'string' ? parsed.requestId : null;
  const attemptNo = typeof parsed.attemptNo === 'number'
    ? parsed.attemptNo
    : (typeof parsed.attemptNo === 'string' ? Number(parsed.attemptNo) : NaN);

  if (!createdAt || !requestId || !Number.isInteger(attemptNo) || attemptNo < 1) {
    throw new Error('Invalid recent-request cursor');
  }

  return {
    createdAt,
    requestId,
    attemptNo
  };
}

function encodeRecentRequestCursor(cursor: RecentRequestCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCapHistoryCursor(cursor: string | undefined): CapHistoryCursor | null {
  if (!cursor) return null;

  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
  const exhaustedAt = typeof parsed.exhaustedAt === 'string' ? parsed.exhaustedAt : null;
  const credentialId = typeof parsed.credentialId === 'string' ? parsed.credentialId : null;
  const windowKind = typeof parsed.windowKind === 'string' ? parsed.windowKind : null;
  const eventId = typeof parsed.eventId === 'string' ? parsed.eventId : null;

  if (!exhaustedAt || !credentialId || !windowKind || !eventId) {
    throw new Error('Invalid cap-history cursor');
  }

  return {
    exhaustedAt,
    credentialId,
    windowKind,
    eventId
  };
}

function encodeCapHistoryCursor(cursor: CapHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeSessionCursor(cursor: string | undefined): SessionCursor | null {
  if (!cursor) return null;

  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
  const lastActivityAt = typeof parsed.lastActivityAt === 'string' ? parsed.lastActivityAt : null;
  const sessionKey = typeof parsed.sessionKey === 'string' ? parsed.sessionKey : null;

  if (!lastActivityAt || !sessionKey) {
    throw new Error('Invalid sessions cursor');
  }

  return {
    lastActivityAt,
    sessionKey
  };
}

function encodeSessionCursor(cursor: SessionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function isMissingReserveColumn(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const details = error as { code?: string; column?: string; message?: string };
  if (details.code !== '42703') return false;
  return details.column === 'five_hour_reserve_percent'
    || details.column === 'seven_day_reserve_percent'
    || details.message?.includes('five_hour_reserve_percent') === true
    || details.message?.includes('seven_day_reserve_percent') === true;
}

function isMissingProviderUsageTable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const details = error as { code?: string; table?: string; relation?: string; column?: string; message?: string };
  if (details.code === '42P01') {
    return details.table === TABLES.tokenCredentialProviderUsage
      || details.relation === TABLES.tokenCredentialProviderUsage
      || details.message?.includes(TABLES.tokenCredentialProviderUsage) === true;
  }
  if (details.code === '42703') {
    return details.column === 'five_hour_utilization_ratio'
      || details.column === 'five_hour_resets_at'
      || details.column === 'seven_day_utilization_ratio'
      || details.column === 'seven_day_resets_at'
      || details.column === 'fetched_at'
      || details.message?.includes('five_hour_utilization_ratio') === true
      || details.message?.includes('five_hour_resets_at') === true
      || details.message?.includes('seven_day_utilization_ratio') === true
      || details.message?.includes('seven_day_resets_at') === true
      || details.message?.includes('fetched_at') === true;
  }
  return false;
}

type TokenHealthSqlOptions = {
  includeReserveColumns: boolean;
  includeProviderUsage: boolean;
};

function effectiveTokenStatusSql(statusSql: string, expiresAtSql: string): string {
  return `
        case
          when ${statusSql} = 'revoked' then 'revoked'
          when ${expiresAtSql} <= now() then 'expired'
          else ${statusSql}
        end
      `;
}

function buildSystemSummaryTokenCountsSql(input: {
  providerFilter: string;
  options: TokenHealthSqlOptions;
}): string {
  const providerUsageCte = input.options.includeProviderUsage
    ? `
      provider_usage as (
        select
          pu.token_credential_id,
          pu.provider,
          pu.five_hour_utilization_ratio,
          pu.seven_day_utilization_ratio
        from ${TABLES.tokenCredentialProviderUsage} pu
      ),
      `
    : '';
  const providerUsageJoin = input.options.includeProviderUsage
    ? 'left join provider_usage pu on pu.token_credential_id = tc.id and pu.provider = tc.provider'
    : '';
  const fiveHourReservePercent = input.options.includeReserveColumns
    ? 'coalesce(tc.five_hour_reserve_percent, 0)'
    : '0';
  const sevenDayReservePercent = input.options.includeReserveColumns
    ? 'coalesce(tc.seven_day_reserve_percent, 0)'
    : '0';
  const effectiveStatus = effectiveTokenStatusSql('tc.status', 'tc.expires_at');
  const usageMaxedExpression = input.options.includeProviderUsage
    ? `
          case
            when ${effectiveStatus} in ('expired', 'revoked')
            then false
            when tc.provider = 'anthropic'
            then (
              pu.token_credential_id is not null
              and (
                coalesce((pu.five_hour_utilization_ratio * 100) >= (100 - ${fiveHourReservePercent}), false)
                or coalesce((pu.seven_day_utilization_ratio * 100) >= (100 - ${sevenDayReservePercent}), false)
              )
            )
            when tc.provider in ('openai', 'codex')
            then (
              tc.status = 'maxed'
              or (
                pu.token_credential_id is not null
                and (
                  coalesce(pu.five_hour_utilization_ratio >= 1, false)
                  or coalesce(pu.seven_day_utilization_ratio >= 1, false)
                )
              )
            )
            else tc.status = 'maxed'
          end
      `
    : `
          tc.status = 'maxed'
      `;

  return `
      WITH ${providerUsageCte}token_inventory AS (
        SELECT
          tc.id,
          tc.provider,
          ${effectiveStatus} AS status,
          ${usageMaxedExpression} AS usage_maxed
        FROM ${TABLES.tokenCredentials} tc
        ${providerUsageJoin}
        ${input.providerFilter}
      )
      SELECT
        count(*) FILTER (WHERE status <> 'expired' AND status <> 'revoked' AND NOT usage_maxed) AS active_tokens,
        count(*) FILTER (WHERE status <> 'expired' AND status <> 'revoked' AND usage_maxed) AS maxed_tokens,
        count(*) FILTER (WHERE status <> 'expired' AND status <> 'revoked') AS total_tokens
      FROM token_inventory
    `;
}

function buildTokenHealthSql(input: {
  credFilter: string;
  maxedWindowFilter: string;
  recoveryWindowFilter: string;
  capExhaustionWindowFilter: string;
  options: TokenHealthSqlOptions;
}): string {
  const reserveSelect = input.options.includeReserveColumns
    ? `
          case
            when tc.provider = 'anthropic' then tc.five_hour_reserve_percent
            else null
          end as five_hour_reserve_percent,
          case
            when tc.provider = 'anthropic' then tc.seven_day_reserve_percent
            else null
          end as seven_day_reserve_percent,
      `
    : `
          null::integer as five_hour_reserve_percent,
          null::integer as seven_day_reserve_percent,
      `;
  const providerUsageCte = input.options.includeProviderUsage
    ? `
      provider_usage as (
        select
          pu.token_credential_id,
          pu.provider,
          pu.five_hour_utilization_ratio,
          pu.five_hour_resets_at,
          pu.seven_day_utilization_ratio,
          pu.seven_day_resets_at,
          pu.fetched_at as provider_usage_fetched_at
        from ${TABLES.tokenCredentialProviderUsage} pu
      ),
      `
    : '';
  const providerUsageJoin = input.options.includeProviderUsage
    ? 'left join provider_usage pu on pu.token_credential_id = cb.id and pu.provider = cb.provider'
    : '';
  const providerUsageSelect = input.options.includeProviderUsage
    ? `
        pu.five_hour_utilization_ratio,
        pu.five_hour_resets_at,
        case
          when cb.provider = 'anthropic'
            and cb.five_hour_reserve_percent is not null
            and pu.token_credential_id is not null
          then (pu.five_hour_utilization_ratio * 100) >= (100 - cb.five_hour_reserve_percent)
          else null
        end as five_hour_contribution_cap_exhausted,
        pu.seven_day_utilization_ratio,
        pu.seven_day_resets_at,
        case
          when cb.provider = 'anthropic'
            and cb.seven_day_reserve_percent is not null
            and pu.token_credential_id is not null
          then (pu.seven_day_utilization_ratio * 100) >= (100 - cb.seven_day_reserve_percent)
          else null
        end as seven_day_contribution_cap_exhausted,
        pu.provider_usage_fetched_at,
      `
    : `
        null::numeric as five_hour_utilization_ratio,
        null::timestamptz as five_hour_resets_at,
        null::boolean as five_hour_contribution_cap_exhausted,
        null::numeric as seven_day_utilization_ratio,
        null::timestamptz as seven_day_resets_at,
        null::boolean as seven_day_contribution_cap_exhausted,
        null::timestamptz as provider_usage_fetched_at,
      `;
  const effectiveStatus = effectiveTokenStatusSql('tc.status', 'tc.expires_at');

  return `
      WITH credential_base AS (
        SELECT
          tc.id,
          tc.debug_label,
          tc.provider,
          tc.encrypted_access_token,
          (tc.encrypted_refresh_token is not null) as has_refresh_token,
          ${effectiveStatus} AS status,
          coalesce(tc.consecutive_failure_count, 0) AS consecutive_failure_count,
          coalesce(tc.consecutive_rate_limit_count, 0) AS consecutive_rate_limit_count,
          tc.last_failed_status,
          tc.last_failed_at,
          tc.last_rate_limited_at,
          tc.last_refresh_error,
          tc.maxed_at,
          tc.rate_limited_until,
          tc.next_probe_at,
          tc.last_probe_at,
          tc.monthly_contribution_limit_units,
          coalesce(tc.monthly_contribution_used_units, 0) AS monthly_contribution_used_units,
          tc.monthly_window_start_at,
          ${reserveSelect}
          tc.created_at,
          tc.expires_at
        FROM ${TABLES.tokenCredentials} tc
        ${input.credFilter}
      ),
      ${providerUsageCte}
      maxed_events AS (
        SELECT
          tce.token_credential_id::text AS credential_id,
          count(*) AS maxed_events_7d
        FROM ${TABLES.tokenCredentialEvents} tce
        JOIN credential_base cb ON cb.id = tce.token_credential_id
        WHERE tce.event_type = 'maxed'
          AND tce.created_at >= now() - interval '7 days'
        GROUP BY tce.token_credential_id
      ),
      maxed_cycles AS (
        SELECT
          cb.id::text AS credential_id,
          cb.created_at AS credential_created_at,
          me.created_at AS maxed_at,
          coalesce(
            (
              SELECT re.created_at
              FROM ${TABLES.tokenCredentialEvents} re
              WHERE re.token_credential_id = me.token_credential_id
                AND re.event_type = 'reactivated'
                AND re.created_at < me.created_at
              ORDER BY re.created_at DESC
              LIMIT 1
            ),
            cb.created_at
          ) AS cycle_start_at,
          (
            SELECT re.created_at
            FROM ${TABLES.tokenCredentialEvents} re
            WHERE re.token_credential_id = me.token_credential_id
              AND re.event_type = 'reactivated'
              AND re.created_at > me.created_at
            ORDER BY re.created_at ASC
            LIMIT 1
          ) AS reactivated_at
        FROM credential_base cb
        JOIN ${TABLES.tokenCredentialEvents} me
          ON me.token_credential_id = cb.id
         AND me.event_type = 'maxed'
      ),
      cycle_rollups AS (
        SELECT
          mc.credential_id,
          mc.maxed_at,
          mc.cycle_start_at,
          mc.reactivated_at,
          coalesce(traffic.request_count, 0)::bigint AS request_count,
          coalesce(traffic.usage_units, 0)::bigint AS usage_units,
          coalesce(traffic.usage_row_count, 0)::bigint AS usage_row_count,
          extract(epoch from (mc.maxed_at - mc.cycle_start_at)) / 86400.0 AS cycle_duration_days,
          CASE
            WHEN mc.reactivated_at IS NOT NULL
            THEN extract(epoch from (mc.reactivated_at - mc.maxed_at)) * 1000.0
            ELSE NULL
          END AS recovery_time_ms
        FROM maxed_cycles mc
        LEFT JOIN LATERAL (
          SELECT
            count(DISTINCT re.request_id) AS request_count,
            coalesce(sum(ul.usage_units), 0) AS usage_units,
            count(ul.id) AS usage_row_count
          FROM ${TABLES.routingEvents} re
          LEFT JOIN ${TABLES.usageLedger} ul
            ON ul.org_id = re.org_id
            AND ul.request_id = re.request_id
            AND ul.attempt_no = re.attempt_no
            AND ul.entry_type = 'usage'
          WHERE re.route_decision->>'tokenCredentialId' = mc.credential_id
            AND re.created_at >= mc.cycle_start_at
            AND re.created_at <= mc.maxed_at
        ) traffic ON true
      ),
      maxed_window_rollups AS (
        SELECT *
        FROM cycle_rollups cr
        WHERE ${input.maxedWindowFilter}
      ),
      recovery_window_rollups AS (
        SELECT *
        FROM cycle_rollups cr
        WHERE cr.reactivated_at IS NOT NULL
          AND ${input.recoveryWindowFilter}
      ),
      claude_cap_exhaustion_cycles AS (
        SELECT
          cb.id::text AS credential_id,
          ce.metadata->>'window' AS cap_window,
          ce.created_at AS exhausted_at,
          coalesce(
            (
              SELECT cc.created_at
              FROM ${TABLES.tokenCredentialEvents} cc
              WHERE cc.token_credential_id = ce.token_credential_id
                AND cc.event_type = 'contribution_cap_cleared'
                AND cc.metadata->>'window' = ce.metadata->>'window'
                AND cc.created_at < ce.created_at
              ORDER BY cc.created_at DESC
              LIMIT 1
            ),
            cb.created_at
          ) AS cycle_start_at
        FROM credential_base cb
        JOIN ${TABLES.tokenCredentialEvents} ce
          ON ce.token_credential_id = cb.id
         AND ce.event_type = 'contribution_cap_exhausted'
        WHERE cb.provider = 'anthropic'
          AND ce.metadata->>'window' in ('5h', '7d')
      ),
      claude_cap_exhaustion_rollups AS (
        SELECT
          cec.credential_id,
          cec.cap_window,
          cec.exhausted_at,
          cec.cycle_start_at,
          coalesce(traffic.usage_units, 0)::bigint AS usage_units
        FROM claude_cap_exhaustion_cycles cec
        LEFT JOIN LATERAL (
          SELECT
            coalesce(sum(ul.usage_units), 0) AS usage_units
          FROM ${TABLES.routingEvents} re
          JOIN ${TABLES.usageLedger} ul
            ON ul.org_id = re.org_id
            AND ul.request_id = re.request_id
            AND ul.attempt_no = re.attempt_no
            AND ul.entry_type = 'usage'
          WHERE re.route_decision->>'tokenCredentialId' = cec.credential_id
            AND re.created_at >= cec.cycle_start_at
            AND re.created_at <= cec.exhausted_at
        ) traffic ON true
      ),
      claude_cap_exhaustion_window_rollups AS (
        SELECT *
        FROM claude_cap_exhaustion_rollups ccer
        WHERE ${input.capExhaustionWindowFilter}
      ),
      claude_cap_exhaustion_summary AS (
        SELECT
          credential_id,
          cap_window,
          count(*)::bigint AS cap_exhaustion_cycles_observed,
          avg(usage_units::numeric) AS avg_usage_units_before_cap_exhaustion,
          (array_agg(usage_units ORDER BY exhausted_at DESC))[1]::bigint
            AS usage_units_before_cap_exhaustion_last_window
        FROM claude_cap_exhaustion_window_rollups
        GROUP BY credential_id, cap_window
      ),
      capacity_window_rollups AS (
        SELECT
          cr.*,
          CASE
            WHEN cr.cycle_duration_days >= 0.25
              AND cr.usage_row_count > 0
              AND cr.cycle_duration_days > 0
            THEN cr.usage_units::numeric / cr.cycle_duration_days::numeric
            ELSE NULL
          END AS daily_capacity_units
        FROM maxed_window_rollups cr
      ),
      maxed_summary AS (
        SELECT
          credential_id,
          count(*)::bigint AS maxing_cycles_observed,
          avg(request_count::numeric) AS avg_requests_before_maxed,
          avg(usage_units::numeric) AS avg_usage_units_before_maxed,
          (array_agg(request_count ORDER BY maxed_at DESC))[1]::bigint AS requests_before_maxed_last_window
        FROM maxed_window_rollups
        GROUP BY credential_id
      ),
      recovery_summary AS (
        SELECT
          credential_id,
          avg(recovery_time_ms) AS avg_recovery_time_ms
        FROM recovery_window_rollups
        GROUP BY credential_id
      ),
      capacity_summary AS (
        SELECT
          credential_id,
          count(*) FILTER (WHERE daily_capacity_units IS NOT NULL)::bigint AS valid_capacity_cycles,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY daily_capacity_units)
            FILTER (WHERE daily_capacity_units IS NOT NULL) AS estimated_daily_capacity_units
        FROM capacity_window_rollups
        GROUP BY credential_id
      ),
      utilization_usage AS (
        SELECT
          re.route_decision->>'tokenCredentialId' AS credential_id,
          coalesce(sum(ul.usage_units), 0)::bigint AS usage_units_24h
        FROM ${TABLES.routingEvents} re
        JOIN ${TABLES.usageLedger} ul
          ON ul.org_id = re.org_id
          AND ul.request_id = re.request_id
          AND ul.attempt_no = re.attempt_no
          AND ul.entry_type = 'usage'
        JOIN credential_base cb
          ON cb.id::text = re.route_decision->>'tokenCredentialId'
        WHERE ul.created_at >= now() - interval '24 hours'
        GROUP BY re.route_decision->>'tokenCredentialId'
      )
      SELECT
        cb.id AS credential_id,
        cb.debug_label,
        cb.provider,
        cb.status,
        cb.encrypted_access_token,
        cb.has_refresh_token,
        cb.consecutive_failure_count,
        cb.consecutive_rate_limit_count,
        cb.last_failed_status,
        cb.last_failed_at,
        cb.last_rate_limited_at,
        cb.last_refresh_error,
        cb.maxed_at,
        cb.rate_limited_until,
        cb.next_probe_at,
        cb.last_probe_at,
        cb.monthly_contribution_limit_units,
        cb.monthly_contribution_used_units,
        cb.monthly_window_start_at,
        coalesce(me.maxed_events_7d, 0) AS maxed_events_7d,
        ms.requests_before_maxed_last_window,
        ms.avg_requests_before_maxed,
        ms.avg_usage_units_before_maxed,
        rs.avg_recovery_time_ms,
        CASE
          WHEN coalesce(cs.valid_capacity_cycles, 0) >= 2
          THEN cs.estimated_daily_capacity_units
          ELSE NULL
        END AS estimated_daily_capacity_units,
        coalesce(ms.maxing_cycles_observed, 0) AS maxing_cycles_observed,
        CASE
          WHEN coalesce(cs.valid_capacity_cycles, 0) >= 2
            AND cs.estimated_daily_capacity_units IS NOT NULL
            AND cs.estimated_daily_capacity_units <> 0
          THEN coalesce(uu.usage_units_24h, 0)::numeric / cs.estimated_daily_capacity_units
          ELSE NULL
        END AS utilization_rate_24h,
        cb.five_hour_reserve_percent,
        ${providerUsageSelect}
        cb.seven_day_reserve_percent,
        case
          when cb.provider = 'anthropic'
          then coalesce(c5.cap_exhaustion_cycles_observed, 0)
          else null
        end AS claude_five_hour_cap_exhaustion_cycles_observed,
        case
          when cb.provider = 'anthropic'
          then c5.usage_units_before_cap_exhaustion_last_window
          else null
        end AS claude_five_hour_usage_units_before_cap_exhaustion_last_window,
        case
          when cb.provider = 'anthropic'
          then c5.avg_usage_units_before_cap_exhaustion
          else null
        end AS claude_five_hour_avg_usage_units_before_cap_exhaustion,
        case
          when cb.provider = 'anthropic'
          then coalesce(c7.cap_exhaustion_cycles_observed, 0)
          else null
        end AS claude_seven_day_cap_exhaustion_cycles_observed,
        case
          when cb.provider = 'anthropic'
          then c7.usage_units_before_cap_exhaustion_last_window
          else null
        end AS claude_seven_day_usage_units_before_cap_exhaustion_last_window,
        case
          when cb.provider = 'anthropic'
          then c7.avg_usage_units_before_cap_exhaustion
          else null
        end AS claude_seven_day_avg_usage_units_before_cap_exhaustion,
        cb.created_at,
        cb.expires_at
      FROM credential_base cb
      ${providerUsageJoin}
      LEFT JOIN maxed_events me ON me.credential_id = cb.id::text
      LEFT JOIN maxed_summary ms ON ms.credential_id = cb.id::text
      LEFT JOIN recovery_summary rs ON rs.credential_id = cb.id::text
      LEFT JOIN capacity_summary cs ON cs.credential_id = cb.id::text
      LEFT JOIN claude_cap_exhaustion_summary c5
        ON c5.credential_id = cb.id::text
       AND c5.cap_window = '5h'
      LEFT JOIN claude_cap_exhaustion_summary c7
        ON c7.credential_id = cb.id::text
       AND c7.cap_window = '7d'
      LEFT JOIN utilization_usage uu ON uu.credential_id = cb.id::text
      ORDER BY cb.provider, cb.debug_label NULLS LAST, cb.id
    `;
}

export class AnalyticsRepository implements AnalyticsRouteRepository {
  constructor(private readonly db: SqlClient) {}

  async getTokenUsage(filters: BaseFilters): Promise<unknown> {
    const params: SqlValue[] = [];
    const where: string[] = [];
    applyBaseFilters(where, params, filters);

    const sql = `
      WITH token_routing AS (
        SELECT
          re.route_decision->>'tokenCredentialId' AS credential_id,
          re.provider,
          re.request_id,
          re.attempt_no,
          re.org_id,
          (${SOURCE_CASE}) AS source
        FROM ${TABLES.routingEvents} re
        WHERE ${where.join(' AND ')}
          AND re.route_decision->>'tokenCredentialId' IS NOT NULL
      ),
      token_usage AS (
        SELECT
          tr.credential_id,
          tr.provider,
          tr.source,
          count(*) AS attempt_count,
          count(DISTINCT tr.request_id) AS request_count,
          coalesce(sum(ul.usage_units), 0) AS usage_units,
          coalesce(sum(ul.retail_equivalent_minor), 0) AS retail_equivalent_minor,
          coalesce(sum(ul.input_tokens), 0) AS input_tokens,
          coalesce(sum(ul.output_tokens), 0) AS output_tokens
        FROM token_routing tr
        LEFT JOIN ${TABLES.usageLedger} ul
          ON ul.org_id = tr.org_id
          AND ul.request_id = tr.request_id
          AND ul.attempt_no = tr.attempt_no
          AND ul.entry_type = 'usage'
        GROUP BY tr.credential_id, tr.provider, tr.source
      )
      SELECT
        tu.credential_id,
        tc.debug_label,
        tu.provider,
        coalesce(tc.status, 'active') AS status,
        sum(tu.attempt_count)::bigint AS attempts,
        sum(tu.request_count)::bigint AS requests,
        sum(tu.usage_units)::bigint AS usage_units,
        sum(tu.retail_equivalent_minor)::bigint AS retail_equivalent_minor,
        sum(tu.input_tokens)::bigint AS input_tokens,
        sum(tu.output_tokens)::bigint AS output_tokens,
        jsonb_agg(
          jsonb_build_object(
            'source', tu.source,
            'attempts', tu.attempt_count,
            'requests', tu.request_count,
            'usage_units', tu.usage_units
          )
        ) AS by_source
      FROM token_usage tu
      LEFT JOIN ${TABLES.tokenCredentials} tc ON tc.id::text = tu.credential_id
      GROUP BY tu.credential_id, tc.debug_label, tu.provider, tc.status
      ORDER BY sum(tu.usage_units) DESC
    `;

    const result = await this.db.query(sql, params);
    return result.rows;
  }

  async getBuyers(filters: BaseFilters): Promise<unknown> {
    const defaultProvider = resolveDefaultBuyerProvider();
    const params: SqlValue[] = [defaultProvider];
    const where: string[] = [];
    applyBaseFilters(where, params, filters);

    const sql = `
      WITH buyer_inventory AS (
        SELECT
          ak.id,
          ak.name,
          ak.org_id,
          ak.preferred_provider,
          o.name AS org_name
        FROM in_api_keys ak
        LEFT JOIN ${TABLES.orgs} o ON o.id = ak.org_id
        WHERE ak.scope = 'buyer_proxy'
      ),
      buyer_rollups AS (
        SELECT
          re.api_key_id,
          count(DISTINCT re.request_id) AS request_count,
          count(*) AS attempt_count,
          coalesce(sum(ul.usage_units), 0) AS usage_units,
          coalesce(sum(ul.retail_equivalent_minor), 0) AS retail_equivalent_minor,
          max(re.created_at) AS last_seen_at,
          CASE WHEN count(*) > 0
            THEN round(count(*) FILTER (WHERE re.upstream_status >= 400 OR re.error_code IS NOT NULL)::numeric / count(*), 4)
            ELSE 0
          END AS error_rate
        FROM ${TABLES.routingEvents} re
        LEFT JOIN ${TABLES.usageLedger} ul
          ON ul.org_id = re.org_id
          AND ul.request_id = re.request_id
          AND ul.attempt_no = re.attempt_no
          AND ul.entry_type = 'usage'
        WHERE ${where.join(' AND ')}
          AND re.api_key_id IS NOT NULL
        GROUP BY re.api_key_id
      ),
      buyer_sources AS (
        SELECT
          re.api_key_id,
          (${SOURCE_CASE}) AS source,
          count(DISTINCT re.request_id) AS request_count,
          count(*) AS attempt_count,
          coalesce(sum(ul.usage_units), 0) AS usage_units
        FROM ${TABLES.routingEvents} re
        LEFT JOIN ${TABLES.usageLedger} ul
          ON ul.org_id = re.org_id
          AND ul.request_id = re.request_id
          AND ul.attempt_no = re.attempt_no
          AND ul.entry_type = 'usage'
        WHERE ${where.join(' AND ')}
          AND re.api_key_id IS NOT NULL
        GROUP BY re.api_key_id, (${SOURCE_CASE})
      ),
      buyer_source_rollups AS (
        SELECT
          api_key_id,
          jsonb_agg(jsonb_build_object(
            'source', source,
            'attempts', attempt_count,
            'requests', request_count,
            'usage_units', usage_units
          )) AS by_source
        FROM buyer_sources
        GROUP BY api_key_id
      ),
      usage_total AS (
        SELECT coalesce(sum(usage_units), 0)::bigint AS total_usage_units
        FROM buyer_rollups
      )
      SELECT
        bi.id AS api_key_id,
        bi.name AS label,
        bi.org_id,
        bi.org_name,
        bi.preferred_provider,
        coalesce(bi.preferred_provider, $1::text) AS effective_provider,
        coalesce(br.request_count, 0)::bigint AS request_count,
        coalesce(br.attempt_count, 0)::bigint AS attempt_count,
        coalesce(br.usage_units, 0)::bigint AS usage_units,
        coalesce(br.retail_equivalent_minor, 0)::bigint AS retail_equivalent_minor,
        CASE
          WHEN ut.total_usage_units > 0
          THEN round(coalesce(br.usage_units, 0)::numeric / ut.total_usage_units, 4)
          ELSE 0
        END AS percent_of_total,
        br.last_seen_at,
        coalesce(br.error_rate, 0) AS error_rate,
        bsr.by_source
      FROM buyer_inventory bi
      LEFT JOIN buyer_rollups br ON br.api_key_id = bi.id
      LEFT JOIN buyer_source_rollups bsr ON bsr.api_key_id = bi.id
      CROSS JOIN usage_total ut
      ORDER BY coalesce(br.usage_units, 0) DESC, bi.name ASC, bi.id ASC
    `;

    const result = await this.db.query(sql, params);
    return result.rows;
  }

  async getTokenHealth(filters: BaseFilters): Promise<unknown> {
    const params: SqlValue[] = [];

    // Provider filter applies to the credential inventory. Source is intentionally ignored
    // for health metrics so derived cycle/utilization fields stay credential-global.
    const credWhere: string[] = [];
    applyCanonicalCredentialProviderFilter(credWhere, params, filters.provider, 'tc.provider');
    applyOrgIdFilter(credWhere, params, filters.orgId, 'tc.org_id');
    const credFilter = credWhere.length > 0 ? `WHERE ${credWhere.join(' AND ')}` : '';
    const maxedWindowFilter = windowSqlRaw(filters.window, 'cr.maxed_at');
    const recoveryWindowFilter = windowSqlRaw(filters.window, 'cr.reactivated_at');
    const capExhaustionWindowFilter = windowSqlRaw(filters.window, 'ccer.exhausted_at');
    let options: TokenHealthSqlOptions = {
      includeReserveColumns: true,
      includeProviderUsage: true
    };

    for (;;) {
      try {
        const result = await this.db.query(buildTokenHealthSql({
          credFilter,
          maxedWindowFilter,
          recoveryWindowFilter,
          capExhaustionWindowFilter,
          options
        }), params);
        return result.rows.map((row) => {
          const record = row as Record<string, unknown>;
          const encryptedAccessToken = record.encrypted_access_token;
          const accessToken = typeof encryptedAccessToken === 'string' || Buffer.isBuffer(encryptedAccessToken)
            ? decryptSecret(encryptedAccessToken)
            : null;
          const diagnosis = deriveTokenCredentialAuthDiagnosis({
            provider: String(record.provider ?? ''),
            accessToken,
            hasRefreshToken: record.has_refresh_token === true,
            lastFailedStatus: typeof record.last_failed_status === 'number' ? record.last_failed_status : null,
            lastRefreshError: typeof record.last_refresh_error === 'string' ? record.last_refresh_error : null
          });

          const {
            encrypted_access_token: _encryptedAccessToken,
            has_refresh_token: _hasRefreshToken,
            ...publicRow
          } = record;

          return {
            ...publicRow,
            ...(diagnosis.authDiagnosis !== null ? { auth_diagnosis: diagnosis.authDiagnosis } : {}),
            ...(diagnosis.accessTokenExpiresAt !== null ? { access_token_expires_at: diagnosis.accessTokenExpiresAt } : {}),
            ...(diagnosis.refreshTokenState !== null ? { refresh_token_state: diagnosis.refreshTokenState } : {})
          };
        });
      } catch (error) {
        const nextOptions: TokenHealthSqlOptions = {
          includeReserveColumns: options.includeReserveColumns && !isMissingReserveColumn(error),
          includeProviderUsage: options.includeProviderUsage && !isMissingProviderUsageTable(error)
        };

        if (
          nextOptions.includeReserveColumns === options.includeReserveColumns
          && nextOptions.includeProviderUsage === options.includeProviderUsage
        ) {
          throw error;
        }

        options = nextOptions;
      }
    }
  }

  async getTokenRouting(filters: BaseFilters): Promise<unknown> {
    const params: SqlValue[] = [];
    const where: string[] = [];
    applyBaseFilters(where, params, filters);
    const recentWhere: string[] = [];
    applyBaseFilters(recentWhere, params, {
      window: '24h',
      provider: filters.provider,
      source: filters.source
    });

    const sql = `
      WITH token_events AS (
        SELECT
          re.route_decision->>'tokenCredentialId' AS credential_id,
          re.provider,
          re.upstream_status,
          re.error_code,
          re.latency_ms,
          re.ttfb_ms,
          re.route_decision->>'provider_selection_reason' AS provider_selection_reason
        FROM ${TABLES.routingEvents} re
        WHERE ${where.join(' AND ')}
          AND re.route_decision->>'tokenCredentialId' IS NOT NULL
      ),
      auth_failures AS (
        SELECT
          re.route_decision->>'tokenCredentialId' AS credential_id,
          count(*) AS auth_failures_24h
        FROM ${TABLES.routingEvents} re
        WHERE ${recentWhere.join(' AND ')}
          AND re.route_decision->>'tokenCredentialId' IS NOT NULL
          AND (re.upstream_status = 401 OR re.upstream_status = 403)
        GROUP BY re.route_decision->>'tokenCredentialId'
      ),
      rate_limits AS (
        SELECT
          re.route_decision->>'tokenCredentialId' AS credential_id,
          count(*) AS rate_limited_24h
        FROM ${TABLES.routingEvents} re
        WHERE ${recentWhere.join(' AND ')}
          AND re.route_decision->>'tokenCredentialId' IS NOT NULL
          AND re.upstream_status = 429
        GROUP BY re.route_decision->>'tokenCredentialId'
      )
      SELECT
        te.credential_id,
        tc.debug_label,
        te.provider,
        count(*) AS total_attempts,
        count(*) FILTER (WHERE te.upstream_status >= 200 AND te.upstream_status < 300) AS success_count,
        count(*) FILTER (WHERE te.upstream_status >= 400 OR te.error_code IS NOT NULL) AS error_count,
        jsonb_agg(
          jsonb_build_object('code', coalesce(te.error_code, te.upstream_status::text), 'count', 1)
        ) FILTER (WHERE te.error_code IS NOT NULL OR te.upstream_status >= 400) AS raw_errors,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY te.latency_ms) FILTER (WHERE te.latency_ms IS NOT NULL) AS latency_p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY te.latency_ms) FILTER (WHERE te.latency_ms IS NOT NULL) AS latency_p95_ms,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY te.ttfb_ms) FILTER (WHERE te.ttfb_ms IS NOT NULL) AS ttfb_p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY te.ttfb_ms) FILTER (WHERE te.ttfb_ms IS NOT NULL) AS ttfb_p95_ms,
        count(*) FILTER (WHERE te.provider_selection_reason = 'fallback_provider_selected') AS fallback_count,
        coalesce(af.auth_failures_24h, 0) AS auth_failures_24h,
        coalesce(rl.rate_limited_24h, 0) AS rate_limited_24h
      FROM token_events te
      LEFT JOIN ${TABLES.tokenCredentials} tc ON tc.id::text = te.credential_id
      LEFT JOIN auth_failures af ON af.credential_id = te.credential_id
      LEFT JOIN rate_limits rl ON rl.credential_id = te.credential_id
      GROUP BY te.credential_id, tc.debug_label, te.provider, af.auth_failures_24h, rl.rate_limited_24h
      ORDER BY count(*) DESC
    `;

    const result = await this.db.query(sql, params);

    // Post-process error breakdowns: collapse from raw_errors array to {code: count}
    return result.rows.map((row: any) => {
      const errorBreakdown: Record<string, number> = {};
      if (Array.isArray(row.raw_errors)) {
        for (const entry of row.raw_errors) {
          const code = String(entry?.code ?? 'unknown');
          errorBreakdown[code] = (errorBreakdown[code] ?? 0) + (entry?.count ?? 1);
        }
      }
      return {
        ...row,
        raw_errors: undefined,
        error_breakdown: Object.entries(errorBreakdown).map(([code, count]) => ({ code, count }))
      };
    });
  }

  async getSystemSummary(filters: BaseFilters): Promise<unknown> {
    const params: SqlValue[] = [];
    const where: string[] = [];
    applyBaseFilters(where, params, filters);
    const maxedParams: SqlValue[] = [];
    const maxedWhere = [
      `event_type = 'maxed'`,
      `created_at >= now() - interval '7 days'`
    ];
    applyCanonicalCredentialProviderFilter(maxedWhere, maxedParams, filters.provider, 'provider');
    applyOrgIdFilter(maxedWhere, maxedParams, filters.orgId, 'org_id');
    const tokenCountParams: SqlValue[] = [];
    const tokenCountWhere: string[] = [];
    applyCanonicalCredentialProviderFilter(tokenCountWhere, tokenCountParams, filters.provider, 'tc.provider');
    applyOrgIdFilter(tokenCountWhere, tokenCountParams, filters.orgId, 'tc.org_id');
    const tokenCountProviderFilter = tokenCountWhere.length > 0
      ? `where ${tokenCountWhere.join(' AND ')}`
      : '';

    // Main aggregates
    const mainSql = `
      SELECT
        count(distinct re.request_id) AS total_requests,
        coalesce(sum(ul.usage_units), 0) AS total_usage_units,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY re.latency_ms) FILTER (WHERE re.latency_ms IS NOT NULL) AS latency_p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY re.latency_ms) FILTER (WHERE re.latency_ms IS NOT NULL) AS latency_p95_ms,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY re.ttfb_ms) FILTER (WHERE re.ttfb_ms IS NOT NULL) AS ttfb_p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY re.ttfb_ms) FILTER (WHERE re.ttfb_ms IS NOT NULL) AS ttfb_p95_ms,
        CASE WHEN count(*) > 0
          THEN round(count(*) FILTER (WHERE re.upstream_status >= 400 OR re.error_code IS NOT NULL)::numeric / count(*), 4)
          ELSE 0
        END AS error_rate,
        CASE WHEN count(*) > 0
          THEN round(count(*) FILTER (WHERE re.route_decision->>'provider_selection_reason' = 'fallback_provider_selected')::numeric / count(*), 4)
          ELSE 0
        END AS fallback_rate
      FROM ${TABLES.routingEvents} re
      LEFT JOIN ${TABLES.usageLedger} ul
        ON ul.org_id = re.org_id
        AND ul.request_id = re.request_id
        AND ul.attempt_no = re.attempt_no
        AND ul.entry_type = 'usage'
      WHERE ${where.join(' AND ')}
    `;

    // Maxed events 7d
    const maxedSql = `
      SELECT count(*) AS maxed_events_7d
      FROM ${TABLES.tokenCredentialEvents}
      WHERE ${maxedWhere.join('\n        AND ')}
    `;

    // By provider
    const byProviderParams: SqlValue[] = [];
    const byProviderWhere: string[] = [];
    applyBaseFilters(byProviderWhere, byProviderParams, filters);
    const byProviderSql = `
      SELECT
        re.provider,
        count(distinct re.request_id) AS request_count,
        coalesce(sum(ul.usage_units), 0) AS usage_units
      FROM ${TABLES.routingEvents} re
      LEFT JOIN ${TABLES.usageLedger} ul
        ON ul.org_id = re.org_id
        AND ul.request_id = re.request_id
        AND ul.attempt_no = re.attempt_no
        AND ul.entry_type = 'usage'
      WHERE ${byProviderWhere.join(' AND ')}
      GROUP BY re.provider
    `;

    // By model
    const byModelParams: SqlValue[] = [];
    const byModelWhere: string[] = [];
    applyBaseFilters(byModelWhere, byModelParams, filters);
    const byModelSql = `
      SELECT
        re.model,
        count(distinct re.request_id) AS request_count,
        coalesce(sum(ul.usage_units), 0) AS usage_units
      FROM ${TABLES.routingEvents} re
      LEFT JOIN ${TABLES.usageLedger} ul
        ON ul.org_id = re.org_id
        AND ul.request_id = re.request_id
        AND ul.attempt_no = re.attempt_no
        AND ul.entry_type = 'usage'
      WHERE ${byModelWhere.join(' AND ')}
      GROUP BY re.model
    `;

    // By source
    const bySourceParams: SqlValue[] = [];
    const bySourceWhere: string[] = [];
    applyBaseFilters(bySourceWhere, bySourceParams, filters);
    const bySourceSql = `
      SELECT
        (${SOURCE_CASE}) AS source,
        count(distinct re.request_id) AS request_count,
        coalesce(sum(ul.usage_units), 0) AS usage_units
      FROM ${TABLES.routingEvents} re
      LEFT JOIN ${TABLES.usageLedger} ul
        ON ul.org_id = re.org_id
        AND ul.request_id = re.request_id
        AND ul.attempt_no = re.attempt_no
        AND ul.entry_type = 'usage'
      WHERE ${bySourceWhere.join(' AND ')}
      GROUP BY (${SOURCE_CASE})
    `;

    // Top buyers
    const topBuyersParams: SqlValue[] = [];
    const topBuyersWhere: string[] = [];
    applyBaseFilters(topBuyersWhere, topBuyersParams, filters);
    const topBuyersSql = `
      SELECT
        re.api_key_id,
        re.org_id,
        count(distinct re.request_id) AS request_count,
        coalesce(sum(ul.usage_units), 0) AS usage_units
      FROM ${TABLES.routingEvents} re
      LEFT JOIN ${TABLES.usageLedger} ul
        ON ul.org_id = re.org_id
        AND ul.request_id = re.request_id
        AND ul.attempt_no = re.attempt_no
        AND ul.entry_type = 'usage'
      WHERE ${topBuyersWhere.join(' AND ')}
        AND re.api_key_id IS NOT NULL
      GROUP BY re.api_key_id, re.org_id
      ORDER BY sum(ul.usage_units) DESC NULLS LAST
      LIMIT 10
    `;

    const tokenCountsPromise = (async () => {
      let options: TokenHealthSqlOptions = {
        includeReserveColumns: true,
        includeProviderUsage: true
      };

      for (;;) {
        try {
          return await this.db.query(
            buildSystemSummaryTokenCountsSql({
              providerFilter: tokenCountProviderFilter,
              options
            }),
            tokenCountParams
          );
        } catch (error) {
          const nextOptions: TokenHealthSqlOptions = {
            includeReserveColumns: options.includeReserveColumns && !isMissingReserveColumn(error),
            includeProviderUsage: options.includeProviderUsage && !isMissingProviderUsageTable(error)
          };

          if (
            nextOptions.includeReserveColumns === options.includeReserveColumns
            && nextOptions.includeProviderUsage === options.includeProviderUsage
          ) {
            throw error;
          }

          options = nextOptions;
        }
      }
    })();

    const [mainResult, tokenCountsResult, maxedResult, byProviderResult, byModelResult, bySourceResult, topBuyersResult] =
      await Promise.all([
        this.db.query(mainSql, params),
        tokenCountsPromise,
        this.db.query(maxedSql, maxedParams),
        this.db.query(byProviderSql, byProviderParams),
        this.db.query(byModelSql, byModelParams),
        this.db.query(bySourceSql, bySourceParams),
        this.db.query(topBuyersSql, topBuyersParams)
      ]);

    const main: any = mainResult.rows[0] ?? {};
    const tokenCounts: any = tokenCountsResult.rows[0] ?? {};
    const maxed: any = maxedResult.rows[0] ?? {};
    const totalUsage = Number(main.total_usage_units) || 0;

    return {
      total_requests: main.total_requests,
      total_usage_units: main.total_usage_units,
      latency_p50_ms: main.latency_p50_ms,
      latency_p95_ms: main.latency_p95_ms,
      ttfb_p50_ms: main.ttfb_p50_ms,
      ttfb_p95_ms: main.ttfb_p95_ms,
      error_rate: main.error_rate,
      fallback_rate: main.fallback_rate,
      active_tokens: tokenCounts.active_tokens,
      maxed_tokens: tokenCounts.maxed_tokens,
      total_tokens: tokenCounts.total_tokens,
      maxed_events_7d: maxed.maxed_events_7d,
      by_provider: byProviderResult.rows,
      by_model: byModelResult.rows,
      by_source: bySourceResult.rows,
      translation_overhead: null,
      top_buyers: topBuyersResult.rows.map((row: any) => ({
        api_key_id: row.api_key_id,
        org_id: row.org_id,
        request_count: row.request_count,
        usage_units: row.usage_units,
        percent_of_total: totalUsage > 0
          ? Math.round((Number(row.usage_units) / totalUsage) * 10000) / 10000
          : 0
      }))
    };
  }

  async getTimeSeries(filters: BaseFilters & { granularity: AnalyticsGranularity; credentialId?: string }): Promise<unknown> {
    const params: SqlValue[] = [];
    const where: string[] = [];
    applyBaseFilters(where, params, filters);

    if (filters.credentialId) {
      params.push(filters.credentialId);
      where.push(`re.route_decision->>'tokenCredentialId' = $${params.length}`);
    }

    const bucketExpr = timeBucketSql(filters.granularity, 're.created_at');

    const sql = `
      SELECT
        ${bucketExpr} AS bucket,
        count(distinct re.request_id) AS request_count,
        coalesce(sum(ul.usage_units), 0) AS usage_units,
        CASE WHEN count(*) > 0
          THEN round(count(*) FILTER (WHERE re.upstream_status >= 400 OR re.error_code IS NOT NULL)::numeric / count(*), 4)
          ELSE 0
        END AS error_rate,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY re.latency_ms)
          FILTER (WHERE re.latency_ms IS NOT NULL) AS latency_p50_ms
      FROM ${TABLES.routingEvents} re
      LEFT JOIN ${TABLES.usageLedger} ul
        ON ul.org_id = re.org_id
        AND ul.request_id = re.request_id
        AND ul.attempt_no = re.attempt_no
        AND ul.entry_type = 'usage'
      WHERE ${where.join(' AND ')}
      GROUP BY ${bucketExpr}
      ORDER BY bucket ASC
    `;

    const result = await this.db.query(sql, params);
    return result.rows;
  }

  async getBuyerTimeSeries(filters: BuyerTimeSeriesFilters): Promise<unknown> {
    const params: SqlValue[] = [];
    const where: string[] = [];
    applyBaseFilters(where, params, filters);
    where.push(`re.api_key_id IS NOT NULL`);

    if (filters.apiKeyIds && filters.apiKeyIds.length > 0) {
      params.push(filters.apiKeyIds);
      where.push(`re.api_key_id = ANY($${params.length}::uuid[])`);
    }

    const bucketExpr = timeBucketSql(filters.granularity, 're.created_at');

    const sql = `
      SELECT
        ${bucketExpr} AS bucket,
        re.api_key_id,
        count(distinct re.request_id) AS request_count,
        coalesce(sum(ul.usage_units), 0) AS usage_units,
        CASE WHEN count(*) > 0
          THEN round(count(*) FILTER (WHERE re.upstream_status >= 400 OR re.error_code IS NOT NULL)::numeric / count(*), 4)
          ELSE 0
        END AS error_rate,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY re.latency_ms)
          FILTER (WHERE re.latency_ms IS NOT NULL) AS latency_p50_ms
      FROM ${TABLES.routingEvents} re
      LEFT JOIN ${TABLES.usageLedger} ul
        ON ul.org_id = re.org_id
        AND ul.request_id = re.request_id
        AND ul.attempt_no = re.attempt_no
        AND ul.entry_type = 'usage'
      WHERE ${where.join(' AND ')}
      GROUP BY ${bucketExpr}, re.api_key_id
      ORDER BY bucket ASC, re.api_key_id ASC
    `;

    const result = await this.db.query(sql, params);
    return result.rows;
  }

  async getRecentRequests(filters: BaseFilters & {
    limit: number;
    credentialId?: string;
    model?: string;
    minLatencyMs?: number;
    cursor?: string;
  }): Promise<unknown> {
    const params: SqlValue[] = [];
    const where: string[] = [];
    applyBaseFilters(where, params, filters);

    if (filters.credentialId) {
      params.push(filters.credentialId);
      where.push(`re.route_decision->>'tokenCredentialId' = $${params.length}`);
    }

    if (filters.model) {
      params.push(filters.model);
      where.push(`re.model = $${params.length}`);
    }

    if (filters.minLatencyMs != null) {
      params.push(filters.minLatencyMs);
      where.push(`re.latency_ms >= $${params.length}`);
    }

    const cursor = decodeRecentRequestCursor(filters.cursor);
    if (cursor) {
      params.push(cursor.createdAt, cursor.requestId, cursor.attemptNo);
      where.push(`(re.created_at, re.request_id, re.attempt_no) < ($${params.length - 2}::timestamptz, $${params.length - 1}::text, $${params.length}::int)`);
    }

    const limit = Math.max(1, Math.min(200, filters.limit));
    params.push(limit + 1);

    const sql = `
      SELECT
        re.request_id,
        re.attempt_no,
        re.created_at,
        re.route_decision->>'tokenCredentialId' AS credential_id,
        tc.debug_label AS credential_label,
        re.provider,
        re.model,
        (${SOURCE_CASE}) AS source,
        CASE WHEN re.route_decision->>'translated' = 'true' THEN true ELSE false END AS translated,
        CASE WHEN re.route_decision->>'rescued' = 'true' THEN true ELSE false END AS rescued,
        re.route_decision->>'rescue_scope' AS rescue_scope,
        re.route_decision->>'rescue_initial_provider' AS rescue_initial_provider,
        re.route_decision->>'rescue_initial_credential_id' AS rescue_initial_credential_id,
        re.route_decision->>'rescue_initial_failure_code' AS rescue_initial_failure_code,
        CASE
          WHEN re.route_decision->>'rescue_initial_failure_status' ~ '^\\d+$'
            THEN (re.route_decision->>'rescue_initial_failure_status')::integer
          ELSE null
        END AS rescue_initial_failure_status,
        re.streaming,
        re.upstream_status,
        re.latency_ms,
        re.ttfb_ms,
        coalesce(ul.input_tokens, 0) AS input_tokens,
        coalesce(ul.output_tokens, 0) AS output_tokens,
        coalesce(ul.usage_units, 0) AS usage_units,
        rl.prompt_preview,
        rl.response_preview
      FROM ${TABLES.routingEvents} re
      LEFT JOIN ${TABLES.usageLedger} ul
        ON ul.org_id = re.org_id
        AND ul.request_id = re.request_id
        AND ul.attempt_no = re.attempt_no
        AND ul.entry_type = 'usage'
      LEFT JOIN ${TABLES.tokenCredentials} tc
        ON tc.id::text = re.route_decision->>'tokenCredentialId'
      LEFT JOIN ${TABLES.requestLog} rl
        ON rl.org_id = re.org_id
        AND rl.request_id = re.request_id
        AND rl.attempt_no = re.attempt_no
      WHERE ${where.join(' AND ')}
      ORDER BY re.created_at DESC, re.request_id DESC, re.attempt_no DESC
      LIMIT $${params.length}
    `;

    const result = await this.db.query(sql, params);
    const rows = result.rows.map((row: any) => ({
      request_id: row.request_id,
      attempt_no: row.attempt_no,
      created_at: row.created_at,
      credential_id: row.credential_id,
      credential_label: row.credential_label,
      provider: row.provider,
      model: row.model,
      source: row.source,
      translated: row.translated,
      rescued: row.rescued,
      rescue_scope: row.rescue_scope,
      rescue_initial_provider: row.rescue_initial_provider,
      rescue_initial_credential_id: row.rescue_initial_credential_id,
      rescue_initial_failure_code: row.rescue_initial_failure_code,
      rescue_initial_failure_status: row.rescue_initial_failure_status,
      streaming: row.streaming,
      upstream_status: row.upstream_status,
      latency_ms: row.latency_ms,
      ttfb_ms: row.ttfb_ms,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      usage_units: row.usage_units,
      prompt_preview: row.prompt_preview,
      response_preview: row.response_preview
    }));

    const requests = rows.slice(0, limit);
    const hasNextPage = rows.length > limit;
    const last = requests[requests.length - 1];

    return {
      requests,
      nextCursor: hasNextPage && last
        ? encodeRecentRequestCursor({
          createdAt: new Date(last.created_at).toISOString(),
          requestId: String(last.request_id),
          attemptNo: Number(last.attempt_no)
        })
        : null
    };
  }

  async getDailyTrends(filters: BaseFilters): Promise<unknown> {
    const params: SqlValue[] = [];
    const where: string[] = [];
    applyBaseFilters(where, params, filters);

    const startDaySql = dayWindowStartSql(filters.window);
    const sql = `
      WITH filtered_events AS (
        SELECT
          (${usageDaySql('re')}) AS day,
          re.request_id,
          re.attempt_no,
          re.provider,
          (${SOURCE_CASE}) AS source,
          re.latency_ms,
          re.upstream_status,
          re.error_code,
          coalesce(ul.usage_units, 0) AS usage_units,
          coalesce(ul.input_tokens, 0) AS input_tokens,
          coalesce(ul.output_tokens, 0) AS output_tokens
        FROM ${TABLES.routingEvents} re
        LEFT JOIN ${TABLES.usageLedger} ul
          ON ul.org_id = re.org_id
          AND ul.request_id = re.request_id
          AND ul.attempt_no = re.attempt_no
          AND ul.entry_type = 'usage'
        WHERE ${where.join(' AND ')}
      ),
      days AS (
        SELECT generate_series(${startDaySql}, (now() at time zone 'utc')::date, interval '1 day')::date AS day
      ),
      day_totals AS (
        SELECT
          fe.day,
          count(DISTINCT fe.request_id) AS requests,
          count(*) AS attempts,
          coalesce(sum(fe.usage_units), 0) AS usage_units,
          coalesce(sum(fe.input_tokens), 0) AS input_tokens,
          coalesce(sum(fe.output_tokens), 0) AS output_tokens,
          CASE
            WHEN count(*) > 0
              THEN round(count(*) FILTER (WHERE fe.upstream_status >= 400 OR fe.error_code IS NOT NULL)::numeric / count(*), 4)
            ELSE 0
          END AS error_rate,
          round(avg(fe.latency_ms)::numeric, 2) AS avg_latency_ms
        FROM filtered_events fe
        GROUP BY fe.day
      ),
      provider_totals AS (
        SELECT
          fe.day,
          fe.provider,
          count(DISTINCT fe.request_id) AS requests,
          coalesce(sum(fe.usage_units), 0) AS usage_units
        FROM filtered_events fe
        GROUP BY fe.day, fe.provider
      ),
      source_totals AS (
        SELECT
          fe.day,
          fe.source,
          count(DISTINCT fe.request_id) AS requests,
          coalesce(sum(fe.usage_units), 0) AS usage_units
        FROM filtered_events fe
        GROUP BY fe.day, fe.source
      )
      SELECT
        d.day,
        coalesce(dt.requests, 0) AS requests,
        coalesce(dt.attempts, 0) AS attempts,
        coalesce(dt.usage_units, 0) AS usage_units,
        coalesce(dt.input_tokens, 0) AS input_tokens,
        coalesce(dt.output_tokens, 0) AS output_tokens,
        coalesce(dt.error_rate, 0) AS error_rate,
        dt.avg_latency_ms,
        coalesce((
          SELECT jsonb_object_agg(
            pt.provider,
            jsonb_build_object(
              'requests', pt.requests,
              'usageUnits', pt.usage_units
            )
          )
          FROM provider_totals pt
          WHERE pt.day = d.day
        ), '{}'::jsonb) AS provider_split,
        coalesce((
          SELECT jsonb_object_agg(
            st.source,
            jsonb_build_object(
              'requests', st.requests,
              'usageUnits', st.usage_units
            )
          )
          FROM source_totals st
          WHERE st.day = d.day
        ), '{}'::jsonb) AS source_split
      FROM days d
      LEFT JOIN day_totals dt
        ON dt.day = d.day
      ORDER BY d.day ASC
    `;

    const result = await this.db.query(sql, params);
    return result.rows;
  }

  async getCapHistory(filters: {
    window: AnalyticsWindow;
    provider?: string;
    orgId?: string;
    credentialId?: string;
    limit: number;
    cursor?: string;
  }): Promise<unknown> {
    const params: SqlValue[] = [];
    const where: string[] = [
      windowSqlRaw(filters.window, 'ce.created_at'),
      `ce.event_type = 'contribution_cap_exhausted'`
    ];

    applyCanonicalCredentialProviderFilter(where, params, filters.provider, 'ce.provider');
    applyOrgIdFilter(where, params, filters.orgId, 'tc.org_id');

    if (filters.credentialId) {
      params.push(filters.credentialId);
      where.push(`ce.token_credential_id = $${params.length}::uuid`);
    }

    const cursor = decodeCapHistoryCursor(filters.cursor);
    const windowStartSql = windowStartTimestampSql(filters.window);
    const limit = Math.max(1, Math.min(200, filters.limit));

    let outerWhere = '';
    if (cursor) {
      params.push(cursor.exhaustedAt, cursor.credentialId, cursor.windowKind, cursor.eventId);
      outerWhere = `WHERE (cycles.exhausted_at, cycles.credential_id, cycles.window_kind, cycles.event_id) < ($${params.length - 3}::timestamptz, $${params.length - 2}::text, $${params.length - 1}::text, $${params.length}::uuid)`;
    }

    params.push(limit + 1);

    const sql = `
      WITH cycles AS (
        SELECT
          ce.id AS event_id,
          ce.token_credential_id::text AS credential_id,
          tc.debug_label AS credential_label,
          ce.provider,
          coalesce(ce.metadata->>'window', 'unknown') AS window_kind,
          ce.created_at AS exhausted_at,
          (
            SELECT cc.created_at
            FROM ${TABLES.tokenCredentialEvents} cc
            WHERE cc.event_type = 'contribution_cap_cleared'
              AND cc.token_credential_id = ce.token_credential_id
              AND coalesce(cc.metadata->>'window', 'unknown') = coalesce(ce.metadata->>'window', 'unknown')
              AND cc.created_at > ce.created_at
            ORDER BY cc.created_at ASC
            LIMIT 1
          ) AS cleared_at,
          CASE
            WHEN (
              SELECT cc.created_at
              FROM ${TABLES.tokenCredentialEvents} cc
              WHERE cc.event_type = 'contribution_cap_cleared'
                AND cc.token_credential_id = ce.token_credential_id
                AND coalesce(cc.metadata->>'window', 'unknown') = coalesce(ce.metadata->>'window', 'unknown')
                AND cc.created_at > ce.created_at
              ORDER BY cc.created_at ASC
              LIMIT 1
            ) IS NULL THEN null
            ELSE round(extract(epoch from ((
              SELECT cc.created_at
              FROM ${TABLES.tokenCredentialEvents} cc
              WHERE cc.event_type = 'contribution_cap_cleared'
                AND cc.token_credential_id = ce.token_credential_id
                AND coalesce(cc.metadata->>'window', 'unknown') = coalesce(ce.metadata->>'window', 'unknown')
                AND cc.created_at > ce.created_at
              ORDER BY cc.created_at ASC
              LIMIT 1
            ) - ce.created_at)) / 60.0)::int
          END AS recovery_minutes,
          coalesce((
            SELECT sum(ul.usage_units)
            FROM ${TABLES.routingEvents} re
            LEFT JOIN ${TABLES.usageLedger} ul
              ON ul.org_id = re.org_id
              AND ul.request_id = re.request_id
              AND ul.attempt_no = re.attempt_no
              AND ul.entry_type = 'usage'
            WHERE re.route_decision->>'tokenCredentialId' = ce.token_credential_id::text
              AND re.created_at > coalesce((
                SELECT max(cc.created_at)
                FROM ${TABLES.tokenCredentialEvents} cc
                WHERE cc.event_type = 'contribution_cap_cleared'
                  AND cc.token_credential_id = ce.token_credential_id
                  AND coalesce(cc.metadata->>'window', 'unknown') = coalesce(ce.metadata->>'window', 'unknown')
                  AND cc.created_at < ce.created_at
              ), ${windowStartSql})
              AND re.created_at <= ce.created_at
          ), 0) AS usage_units_before_cap,
          (
            SELECT count(DISTINCT re.request_id)
            FROM ${TABLES.routingEvents} re
            WHERE re.route_decision->>'tokenCredentialId' = ce.token_credential_id::text
              AND re.created_at > coalesce((
                SELECT max(cc.created_at)
                FROM ${TABLES.tokenCredentialEvents} cc
                WHERE cc.event_type = 'contribution_cap_cleared'
                  AND cc.token_credential_id = ce.token_credential_id
                  AND coalesce(cc.metadata->>'window', 'unknown') = coalesce(ce.metadata->>'window', 'unknown')
                  AND cc.created_at < ce.created_at
              ), ${windowStartSql})
              AND re.created_at <= ce.created_at
          ) AS requests_before_cap,
          coalesce(ce.reason, ce.metadata->>'reason') AS exhaustion_reason
        FROM ${TABLES.tokenCredentialEvents} ce
        LEFT JOIN ${TABLES.tokenCredentials} tc
          ON tc.id = ce.token_credential_id
        WHERE ${where.join(' AND ')}
      )
      SELECT
        cycles.event_id,
        cycles.credential_id,
        cycles.credential_label,
        cycles.provider,
        cycles.window_kind,
        cycles.exhausted_at,
        cycles.cleared_at,
        cycles.recovery_minutes,
        cycles.usage_units_before_cap,
        cycles.requests_before_cap,
        cycles.exhaustion_reason
      FROM cycles
      ${outerWhere}
      ORDER BY cycles.exhausted_at DESC, cycles.credential_id DESC, cycles.window_kind DESC, cycles.event_id DESC
      LIMIT $${params.length}
    `;

    const result = await this.db.query(sql, params);
    const cycles = result.rows.slice(0, limit);
    const hasNextPage = result.rows.length > limit;
    const last = cycles[cycles.length - 1] as Record<string, unknown> | undefined;

    return {
      cycles,
      nextCursor: hasNextPage && last
        ? encodeCapHistoryCursor({
          exhaustedAt: new Date(String(last.exhausted_at)).toISOString(),
          credentialId: String(last.credential_id),
          windowKind: String(last.window_kind),
          eventId: String(last.event_id)
        })
        : null
    };
  }

  async getSessions(filters: BaseFilters & {
    limit: number;
    cursor?: string;
    sessionType?: 'cli' | 'openclaw';
    model?: string;
    status?: 'success' | 'failed' | 'partial';
  }): Promise<unknown> {
    const params: SqlValue[] = [];
    const where = [windowSqlRaw(filters.window, 'last_activity_at')];

    if (filters.sessionType) {
      params.push(filters.sessionType);
      where.push(`session_type = $${params.length}`);
    } else if (filters.source === 'openclaw') {
      params.push('openclaw');
      where.push(`session_type = $${params.length}`);
    } else if (filters.source === 'cli-claude' || filters.source === 'cli-codex') {
      params.push('cli');
      where.push(`session_type = $${params.length}`);
    } else if (filters.source === 'direct') {
      params.push('__never__');
      where.push(`session_type = $${params.length}`);
    }

    if (filters.provider) {
      params.push(filters.provider);
      where.push(`$${params.length} = any(provider_set)`);
    }

    if (filters.model) {
      params.push(filters.model);
      where.push(`$${params.length} = any(model_set)`);
    }

    if (filters.status) {
      params.push(filters.status);
      where.push(`coalesce((status_summary ->> $${params.length})::int, 0) > 0`);
    }

    if (filters.orgId) {
      params.push(filters.orgId);
      where.push(`org_id = $${params.length}`);
    }

    const cursor = decodeSessionCursor(filters.cursor);
    if (cursor) {
      params.push(cursor.lastActivityAt);
      const timeIndex = params.length;
      params.push(cursor.sessionKey);
      const keyIndex = params.length;
      where.push(`(
        last_activity_at < $${timeIndex}::timestamptz
        or (last_activity_at = $${timeIndex}::timestamptz and session_key < $${keyIndex})
      )`);
    }

    const limit = Math.max(1, Math.min(200, filters.limit));
    params.push(limit + 1);

    const sql = `
      select
        session_key,
        session_type,
        grouping_basis,
        started_at,
        ended_at,
        round(extract(epoch from (ended_at - started_at)) * 1000)::bigint as duration_ms,
        request_count,
        attempt_count,
        input_tokens,
        output_tokens,
        provider_set,
        model_set,
        status_summary,
        preview_sample,
        last_activity_at
      from ${TABLES.adminSessions}
      where ${where.join(' and ')}
      order by last_activity_at desc, session_key desc
      limit $${params.length}
    `;

    const result = await this.db.query(sql, params);
    const sessions = result.rows.slice(0, limit);
    const hasNextPage = result.rows.length > limit;
    const last = sessions[sessions.length - 1] as Record<string, unknown> | undefined;

    return {
      sessions,
      nextCursor: hasNextPage && last
        ? encodeSessionCursor({
          lastActivityAt: new Date(String(last.last_activity_at)).toISOString(),
          sessionKey: String(last.session_key)
        })
        : null
    };
  }

  async getEvents(filters: EventFilters): Promise<unknown> {
    const params: SqlValue[] = [];
    const where: string[] = [windowSqlRaw(filters.window, 'tce.created_at')];

    if (filters.provider) {
      params.push(filters.provider);
      where.push(`tce.provider = $${params.length}`);
    }

    if (filters.orgId) {
      params.push(filters.orgId);
      where.push(`tc.org_id = $${params.length}`);
    }

    const limit = Math.max(1, Math.min(200, filters.limit));
    params.push(limit);

    const sql = `
      SELECT
        tce.id,
        tce.event_type,
        tce.created_at,
        tce.provider,
        tce.token_credential_id::text AS credential_id,
        tc.debug_label AS credential_label,
        tce.status_code,
        tce.reason,
        tce.metadata,
        CASE
          WHEN tce.event_type in ('reactivated', 'contribution_cap_cleared', 'paused', 'unpaused') THEN 'info'
          ELSE 'warn'
        END AS severity,
        CASE
          WHEN tce.event_type = 'maxed' THEN 'credential maxed'
          WHEN tce.event_type = 'reactivated' THEN 'credential reactivated'
          WHEN tce.event_type = 'probe_failed' THEN 'probe failed'
          WHEN tce.event_type = 'paused' THEN 'credential paused'
          WHEN tce.event_type = 'unpaused' THEN 'credential unpaused'
          WHEN tce.event_type = 'contribution_cap_exhausted'
            THEN coalesce(tce.metadata->>'window', 'cap') || ' contribution cap exhausted'
          WHEN tce.event_type = 'contribution_cap_cleared'
            THEN coalesce(tce.metadata->>'window', 'cap') || ' contribution cap cleared'
          ELSE tce.event_type
        END AS summary
      FROM ${TABLES.tokenCredentialEvents} tce
      LEFT JOIN ${TABLES.tokenCredentials} tc
        ON tc.id = tce.token_credential_id
      WHERE ${where.join(' AND ')}
      ORDER BY tce.created_at DESC
      LIMIT $${params.length}
    `;

    const result = await this.db.query(sql, params);
    return result.rows;
  }

  async getAnomalies(filters: BaseFilters): Promise<unknown> {
    // Build routing-event filters for provider + source
    const routingFilters: string[] = [];
    const routingParams: SqlValue[] = [];
    if (filters.provider) {
      routingParams.push(filters.provider);
      routingFilters.push(`re.provider = $${routingParams.length}`);
    }
    if (filters.source) {
      routingParams.push(filters.source);
      routingFilters.push(`(${SOURCE_CASE}) = $${routingParams.length}`);
    }
    const routingExtra = routingFilters.length > 0
      ? ' AND ' + routingFilters.join(' AND ')
      : '';

    // Provider filter for credential-metadata query (source is not applicable)
    const credProviderFilter = filters.provider
      ? ` AND provider = $1`
      : '';
    const credParams: SqlValue[] = filters.provider ? [filters.provider] : [];

    // Aggregate confidence checks are provider-shaped, not source-shaped.
    const aggregateParams: SqlValue[] = [];
    const aggregateUsageWhere = [
      `ul.entry_type = 'usage'`,
      windowSql(filters.window, 'ul')
    ];
    const aggregateDailyWhere = [
      dayWindowSql(filters.window, 'da.day')
    ];
    if (filters.provider) {
      aggregateParams.push(filters.provider);
      aggregateUsageWhere.push(`ul.provider = $${aggregateParams.length}`);
      aggregateDailyWhere.push(`da.provider = $${aggregateParams.length}`);
    }
    const currentUtcDaySql = `(now() at time zone 'utc')::date`;

    const [missingLabels, unresolvedCreds, nullCredRouting, staleAggregates, aggregateMismatches] = await Promise.all([
      this.db.query(`
        SELECT count(*) AS cnt
        FROM ${TABLES.tokenCredentials}
        WHERE (debug_label IS NULL OR trim(debug_label) = '')${credProviderFilter}
      `, credParams),
      this.db.query(`
        SELECT count(DISTINCT re.route_decision->>'tokenCredentialId') AS cnt
        FROM ${TABLES.routingEvents} re
        WHERE re.route_decision->>'tokenCredentialId' IS NOT NULL
          AND ${windowSqlRaw(filters.window, 're.created_at')}${routingExtra}
          AND NOT EXISTS (
            SELECT 1 FROM ${TABLES.tokenCredentials} tc
            WHERE tc.id::text = re.route_decision->>'tokenCredentialId'
          )
      `, routingParams),
      this.db.query(`
        SELECT count(*) AS cnt
        FROM ${TABLES.routingEvents} re
        WHERE re.route_decision->>'tokenCredentialId' IS NULL
          AND re.seller_key_id IS NULL
          AND ${windowSqlRaw(filters.window, 're.created_at')}${routingExtra}
      `, routingParams),
      this.db.query(`
        WITH raw_windows AS (
          SELECT
            ${usageDaySql('ul')} AS day,
            ul.org_id,
            ul.seller_key_id,
            ul.provider,
            ul.model,
            max(ul.created_at) AS latest_raw_at
          FROM ${TABLES.usageLedger} ul
          WHERE ${aggregateUsageWhere.join(' AND ')}
          GROUP BY 1,2,3,4,5
        ),
        joined AS (
          SELECT
            rw.day,
            rw.latest_raw_at,
            da.updated_at,
            CASE
              WHEN rw.day = ${currentUtcDaySql}
              THEN rw.latest_raw_at + interval '20 minutes'
              ELSE greatest(
                rw.latest_raw_at + interval '20 minutes',
                ${closedAggregateRefreshDeadlineSql('rw.day')}
              )
            END AS refresh_due_at
          FROM raw_windows rw
          LEFT JOIN ${TABLES.dailyAggregates} da
            ON da.day = rw.day
            AND da.org_id = rw.org_id
            AND da.seller_key_id IS NOT DISTINCT FROM rw.seller_key_id
            AND da.provider = rw.provider
            AND da.model = rw.model
        )
        SELECT count(*) AS cnt
        FROM joined
        WHERE now() >= refresh_due_at
          AND (
            updated_at IS NULL
            OR updated_at < latest_raw_at
          )
      `, aggregateParams),
      this.db.query(`
        WITH candidate_days AS (
          SELECT DISTINCT day
          FROM (
            SELECT DISTINCT ${usageDaySql('ul')} AS day
            FROM ${TABLES.usageLedger} ul
            WHERE ${aggregateUsageWhere.join(' AND ')}
            UNION
            SELECT DISTINCT da.day
            FROM ${TABLES.dailyAggregates} da
            WHERE ${aggregateDailyWhere.join(' AND ')}
          ) AS candidate_day_union
        ),
        closed_candidate_days AS (
          SELECT day
          FROM candidate_days
          WHERE day < ${currentUtcDaySql}
        ),
        raw_windows AS (
          SELECT
            ${usageDaySql('ul')} AS day,
            ul.org_id,
            ul.seller_key_id,
            ul.provider,
            ul.model,
            count(*) AS requests_count,
            coalesce(sum(ul.usage_units), 0) AS usage_units,
            coalesce(sum(ul.retail_equivalent_minor), 0) AS retail_equivalent_minor
          FROM ${TABLES.usageLedger} ul
          WHERE ul.entry_type = 'usage'
            AND ${usageDaySql('ul')} IN (SELECT day FROM closed_candidate_days)
            ${filters.provider ? 'AND ul.provider = $1' : ''}
          GROUP BY 1,2,3,4,5
        ),
        aggregate_windows AS (
          SELECT
            da.day,
            da.org_id,
            da.seller_key_id,
            da.provider,
            da.model,
            da.requests_count,
            da.usage_units,
            da.retail_equivalent_minor
          FROM ${TABLES.dailyAggregates} da
          WHERE ${aggregateDailyWhere.join(' AND ')}
            AND da.day IN (SELECT day FROM closed_candidate_days)
        ),
        joined AS (
          SELECT
            coalesce(rw.requests_count, NULL) AS raw_requests_count,
            coalesce(aw.requests_count, NULL) AS aggregate_requests_count,
            coalesce(rw.usage_units, NULL) AS raw_usage_units,
            coalesce(aw.usage_units, NULL) AS aggregate_usage_units,
            coalesce(rw.retail_equivalent_minor, NULL) AS raw_retail_equivalent_minor,
            coalesce(aw.retail_equivalent_minor, NULL) AS aggregate_retail_equivalent_minor
          FROM raw_windows rw
          FULL OUTER JOIN aggregate_windows aw
            ON aw.day = rw.day
            AND aw.org_id = rw.org_id
            AND aw.seller_key_id IS NOT DISTINCT FROM rw.seller_key_id
            AND aw.provider = rw.provider
            AND aw.model = rw.model
        )
        SELECT count(*) AS cnt
        FROM joined
        WHERE raw_requests_count IS DISTINCT FROM aggregate_requests_count
          OR raw_usage_units IS DISTINCT FROM aggregate_usage_units
          OR raw_retail_equivalent_minor IS DISTINCT FROM aggregate_retail_equivalent_minor
      `, aggregateParams)
    ]);

    const checks = {
      missing_debug_labels: Number((missingLabels.rows[0] as any)?.cnt ?? 0),
      unresolved_credential_ids_in_token_mode_usage: Number((unresolvedCreds.rows[0] as any)?.cnt ?? 0),
      null_credential_ids_in_routing: Number((nullCredRouting.rows[0] as any)?.cnt ?? 0),
      stale_aggregate_windows: Number((staleAggregates.rows[0] as any)?.cnt ?? 0),
      usage_ledger_vs_aggregate_mismatch_count: Number((aggregateMismatches.rows[0] as any)?.cnt ?? 0)
    };

    return {
      checks,
      ok: Object.values(checks).every((v) => v === null || v === 0)
    };
  }
}
