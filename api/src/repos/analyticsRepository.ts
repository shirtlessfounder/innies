import type { SqlClient, SqlValue } from './sqlClient.js';
import { TABLES } from './tableNames.js';
import type { AnalyticsRouteRepository } from '../routes/analytics.js';

type AnalyticsWindow = '24h' | '7d' | '1m' | 'all';

type BaseFilters = {
  window: AnalyticsWindow;
  provider?: string;
  source?: string;
};

function windowSql(window: AnalyticsWindow, alias = 're'): string {
  switch (window) {
    case '24h': return `${alias}.created_at >= now() - interval '24 hours'`;
    case '7d':  return `${alias}.created_at >= now() - interval '7 days'`;
    case '1m':  return `${alias}.created_at >= now() - interval '30 days'`;
    case 'all': return '1=1';
    default:    return '1=1';
  }
}

function windowSqlRaw(window: AnalyticsWindow, col = 'created_at'): string {
  switch (window) {
    case '24h': return `${col} >= now() - interval '24 hours'`;
    case '7d':  return `${col} >= now() - interval '7 days'`;
    case '1m':  return `${col} >= now() - interval '30 days'`;
    case 'all': return '1=1';
    default:    return '1=1';
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
          count(*) AS request_count,
          coalesce(sum(ul.usage_units), 0) AS usage_units,
          coalesce(sum(ul.retail_equivalent_minor), 0) AS retail_equivalent_minor,
          coalesce(sum(ul.input_tokens), 0) AS input_tokens,
          coalesce(sum(ul.output_tokens), 0) AS output_tokens
        FROM token_routing tr
        LEFT JOIN ${TABLES.usageLedger} ul
          ON ul.org_id = tr.org_id
          AND ul.request_id = tr.request_id
          AND ul.attempt_no = tr.attempt_no
        GROUP BY tr.credential_id, tr.provider, tr.source
      )
      SELECT
        tu.credential_id,
        tc.debug_label,
        tu.provider,
        coalesce(tc.status, 'active') AS status,
        sum(tu.request_count)::bigint AS requests,
        sum(tu.usage_units)::bigint AS usage_units,
        sum(tu.retail_equivalent_minor)::bigint AS retail_equivalent_minor,
        sum(tu.input_tokens)::bigint AS input_tokens,
        sum(tu.output_tokens)::bigint AS output_tokens,
        jsonb_agg(
          jsonb_build_object(
            'source', tu.source,
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

  async getTokenHealth(filters: BaseFilters): Promise<unknown> {
    const params: SqlValue[] = [];

    // Provider filter for the credential list itself
    const credWhere: string[] = [];
    if (filters.provider) {
      params.push(filters.provider);
      credWhere.push(`tc.provider = $${params.length}`);
    }
    const credFilter = credWhere.length > 0 ? `WHERE ${credWhere.join(' AND ')}` : '';

    const sql = `
      WITH maxed_events AS (
        SELECT
          tce.token_credential_id::text AS credential_id,
          count(*) AS maxed_events_7d
        FROM ${TABLES.tokenCredentialEvents} tce
        WHERE tce.event_type = 'maxed'
          AND tce.created_at >= now() - interval '7 days'
        GROUP BY tce.token_credential_id
      )
      SELECT
        tc.id AS credential_id,
        tc.debug_label,
        tc.provider,
        tc.status,
        coalesce(tc.consecutive_failure_count, 0) AS consecutive_failure_count,
        tc.last_failed_status,
        tc.last_failed_at,
        tc.maxed_at,
        tc.next_probe_at,
        tc.last_probe_at,
        tc.monthly_contribution_limit_units,
        coalesce(tc.monthly_contribution_used_units, 0) AS monthly_contribution_used_units,
        tc.monthly_window_start_at,
        coalesce(me.maxed_events_7d, 0) AS maxed_events_7d,
        NULL AS requests_before_maxed_last_window,
        NULL AS avg_requests_before_maxed,
        NULL AS avg_usage_units_before_maxed,
        NULL AS avg_recovery_time_ms,
        NULL AS estimated_daily_capacity_units,
        NULL AS maxing_cycles_observed,
        NULL AS utilization_rate_24h,
        tc.created_at,
        tc.expires_at
      FROM ${TABLES.tokenCredentials} tc
      LEFT JOIN maxed_events me ON me.credential_id = tc.id::text
      ${credFilter}
      ORDER BY tc.provider, tc.debug_label NULLS LAST
    `;

    const result = await this.db.query(sql, params);
    return result.rows;
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
    const providerOnlyParams: SqlValue[] = [];
    const providerOnlyFilter = filters.provider
      ? (() => {
          providerOnlyParams.push(filters.provider);
          return ` where provider = $${providerOnlyParams.length}`;
        })()
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
      WHERE ${where.join(' AND ')}
    `;

    // Token counts
    const tokenCountsSql = `
      SELECT
        count(*) FILTER (WHERE status = 'active') AS active_tokens,
        count(*) FILTER (WHERE status = 'maxed') AS maxed_tokens,
        count(*) AS total_tokens
      FROM ${TABLES.tokenCredentials}${providerOnlyFilter}
    `;

    // Maxed events 7d
    const maxedSql = `
      SELECT count(*) AS maxed_events_7d
      FROM ${TABLES.tokenCredentialEvents}
      WHERE event_type = 'maxed'
        AND created_at >= now() - interval '7 days'${filters.provider ? ` AND provider = $${providerOnlyParams.length}` : ''}
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
        ON ul.org_id = re.org_id AND ul.request_id = re.request_id AND ul.attempt_no = re.attempt_no
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
        ON ul.org_id = re.org_id AND ul.request_id = re.request_id AND ul.attempt_no = re.attempt_no
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
        ON ul.org_id = re.org_id AND ul.request_id = re.request_id AND ul.attempt_no = re.attempt_no
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
        ON ul.org_id = re.org_id AND ul.request_id = re.request_id AND ul.attempt_no = re.attempt_no
      WHERE ${topBuyersWhere.join(' AND ')}
        AND re.api_key_id IS NOT NULL
      GROUP BY re.api_key_id, re.org_id
      ORDER BY sum(ul.usage_units) DESC NULLS LAST
      LIMIT 10
    `;

    const [mainResult, tokenCountsResult, maxedResult, byProviderResult, byModelResult, bySourceResult, topBuyersResult] =
      await Promise.all([
        this.db.query(mainSql, params),
        this.db.query(tokenCountsSql, providerOnlyParams),
        this.db.query(maxedSql, providerOnlyParams),
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

  async getTimeSeries(filters: BaseFilters & { granularity: 'hour' | 'day'; credentialId?: string }): Promise<unknown> {
    const params: SqlValue[] = [];
    const where: string[] = [];
    applyBaseFilters(where, params, filters);

    if (filters.credentialId) {
      params.push(filters.credentialId);
      where.push(`re.route_decision->>'tokenCredentialId' = $${params.length}`);
    }

    const truncFn = filters.granularity === 'hour' ? 'hour' : 'day';

    const sql = `
      SELECT
        date_trunc('${truncFn}', re.created_at) AS bucket,
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
      WHERE ${where.join(' AND ')}
      GROUP BY date_trunc('${truncFn}', re.created_at)
      ORDER BY bucket ASC
    `;

    const result = await this.db.query(sql, params);
    return result.rows;
  }

  async getRecentRequests(filters: BaseFilters & {
    limit: number;
    credentialId?: string;
    model?: string;
    minLatencyMs?: number;
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

    const limit = Math.max(1, Math.min(200, filters.limit));
    params.push(limit);

    const sql = `
      SELECT
        re.request_id,
        re.created_at,
        re.route_decision->>'tokenCredentialId' AS credential_id,
        tc.debug_label AS credential_label,
        re.provider,
        re.model,
        (${SOURCE_CASE}) AS source,
        CASE WHEN re.route_decision->>'translated' = 'true' THEN true ELSE false END AS translated,
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
      LEFT JOIN ${TABLES.tokenCredentials} tc
        ON tc.id::text = re.route_decision->>'tokenCredentialId'
      LEFT JOIN ${TABLES.requestLog} rl
        ON rl.org_id = re.org_id
        AND rl.request_id = re.request_id
        AND rl.attempt_no = re.attempt_no
      WHERE ${where.join(' AND ')}
      ORDER BY re.created_at DESC
      LIMIT $${params.length}
    `;

    const result = await this.db.query(sql, params);
    return result.rows.map((row: any) => ({
      request_id: row.request_id,
      created_at: row.created_at,
      credential_id: row.credential_id,
      credential_label: row.credential_label,
      provider: row.provider,
      model: row.model,
      source: row.source,
      translated: row.translated,
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

    const [missingLabels, unresolvedCreds, nullCredRouting] = await Promise.all([
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
      `, routingParams)
    ]);

    const checks = {
      missing_debug_labels: Number((missingLabels.rows[0] as any)?.cnt ?? 0),
      unresolved_credential_ids_in_token_mode_usage: Number((unresolvedCreds.rows[0] as any)?.cnt ?? 0),
      null_credential_ids_in_routing: Number((nullCredRouting.rows[0] as any)?.cnt ?? 0),
      stale_aggregate_windows: null as number | null,
      usage_ledger_vs_aggregate_mismatch_count: null as number | null
    };

    return {
      checks,
      ok: Object.values(checks).every((v) => v === null || v === 0)
    };
  }
}
