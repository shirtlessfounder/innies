import type { SqlClient, SqlValue } from './sqlClient.js';
import { TABLES } from './tableNames.js';
import type { AdminAnalysisTaskCategory } from './adminAnalysisRequestRepository.js';

export type AdminAnalysisWindowSlice = {
  start: Date;
  end: Date;
  orgId?: string;
  sessionType?: 'cli' | 'openclaw';
  provider?: string;
  source?: string;
  taskCategory?: AdminAnalysisTaskCategory;
  taskTag?: string;
};

export class AdminAnalysisQueryRepository {
  constructor(private readonly db: SqlClient) {}

  async getOverview(filters: AdminAnalysisWindowSlice): Promise<{
    totals: {
      totalRequests: number;
      totalSessions: number;
      totalTokens: number;
    };
    categoryMix: Array<{ taskCategory: string; count: number }>;
    tagHighlights: Array<{ tag: string; count: number }>;
    signalCounts: {
      retryCount: number;
      failureCount: number;
    };
  }> {
    const requestScope = buildRequestScope(filters);
    const sessionScope = buildSessionScope(filters);

    const totalsSql = `
      select
        count(*)::bigint as total_requests,
        coalesce(sum(input_tokens + output_tokens), 0)::bigint as total_tokens
      from ${TABLES.adminAnalysisRequests}
      where ${requestScope.where.join(' and ')}
    `;
    const totalsResult = await this.db.query<{ total_requests: string; total_tokens: string }>(totalsSql, requestScope.params);

    const sessionsSql = `
      select count(*)::bigint as total_sessions
      from ${TABLES.adminAnalysisSessions} s
      where ${sessionScope.where.join(' and ')}
    `;
    const sessionsResult = await this.db.query<{ total_sessions: string }>(sessionsSql, sessionScope.params);

    const categorySql = `
      select task_category, count(*)::bigint as count
      from ${TABLES.adminAnalysisRequests}
      where ${requestScope.where.join(' and ')}
      group by task_category
      order by count desc, task_category asc
    `;
    const categoryResult = await this.db.query<{ task_category: string; count: string }>(categorySql, requestScope.params);

    const tagsSql = `
      select tag, count(*)::bigint as count
      from ${TABLES.adminAnalysisRequests}
      cross join unnest(task_tags) as tag
      where ${requestScope.where.join(' and ')}
      group by tag
      order by count desc, tag asc
      limit 20
    `;
    const tagsResult = await this.db.query<{ tag: string; count: string }>(tagsSql, requestScope.params);

    const signalSql = `
      select
        sum(case when is_retry then 1 else 0 end)::bigint as retry_count,
        sum(case when is_failure then 1 else 0 end)::bigint as failure_count
      from ${TABLES.adminAnalysisRequests}
      where ${requestScope.where.join(' and ')}
    `;
    const signalResult = await this.db.query<{ retry_count: string; failure_count: string }>(signalSql, requestScope.params);

    return {
      totals: {
        totalRequests: Number(totalsResult.rows[0]?.total_requests ?? 0),
        totalSessions: Number(sessionsResult.rows[0]?.total_sessions ?? 0),
        totalTokens: Number(totalsResult.rows[0]?.total_tokens ?? 0)
      },
      categoryMix: categoryResult.rows.map((row) => ({
        taskCategory: row.task_category,
        count: Number(row.count)
      })),
      tagHighlights: tagsResult.rows.map((row) => ({
        tag: row.tag,
        count: Number(row.count)
      })),
      signalCounts: {
        retryCount: Number(signalResult.rows[0]?.retry_count ?? 0),
        failureCount: Number(signalResult.rows[0]?.failure_count ?? 0)
      }
    };
  }

  async getCategoryTrends(filters: AdminAnalysisWindowSlice): Promise<Array<{
    day: string;
    taskCategory: string;
    count: number;
  }>> {
    const scope = buildRequestScope(filters);
    const sql = `
      select
        (started_at at time zone 'utc')::date as day,
        task_category,
        count(*)::bigint as count
      from ${TABLES.adminAnalysisRequests}
      where ${scope.where.join(' and ')}
      group by day, task_category
      order by day asc, task_category asc
    `;
    const result = await this.db.query<{ day: string; task_category: string; count: string }>(sql, scope.params);
    return result.rows.map((row) => ({
      day: row.day,
      taskCategory: row.task_category,
      count: Number(row.count)
    }));
  }

  async getTagTrends(filters: AdminAnalysisWindowSlice): Promise<{
    topTags: Array<{ tag: string; count: number }>;
    cooccurringTags: Array<{ tag: string; coTag: string; count: number }>;
  }> {
    const scope = buildRequestScope(filters);
    const topTagsSql = `
      select tag, count(*)::bigint as count
      from ${TABLES.adminAnalysisRequests}
      cross join unnest(task_tags) as tag
      where ${scope.where.join(' and ')}
      group by tag
      order by count desc, tag asc
      limit 50
    `;
    const topTags = await this.db.query<{ tag: string; count: string }>(topTagsSql, scope.params);

    const coTagSql = `
      select
        tag,
        co_tag,
        count(*)::bigint as count
      from (
        select
          tag,
          co_tag
        from ${TABLES.adminAnalysisRequests} r2
        cross join unnest(r2.task_tags) as tag
        left join lateral unnest(r2.task_tags) as co_tag on true
        where ${scope.where.join(' and ')}
          and co_tag is not null
          and co_tag <> tag
      ) pairs
      group by tag, co_tag
      order by count desc, tag asc, co_tag asc
      limit 100
    `;
    const coTags = await this.db.query<{ tag: string; co_tag: string; count: string }>(coTagSql, scope.params);

    return {
      topTags: topTags.rows.map((row) => ({
        tag: row.tag,
        count: Number(row.count)
      })),
      cooccurringTags: coTags.rows.map((row) => ({
        tag: row.tag,
        coTag: row.co_tag,
        count: Number(row.count)
      }))
    };
  }

  async getInterestingSignals(filters: AdminAnalysisWindowSlice): Promise<{
    retryCount: number;
    failureCount: number;
    partialCount: number;
    highTokenCount: number;
    crossProviderRescueCount: number;
    toolUseCount: number;
    longSessionCount: number;
    highTokenSessionCount: number;
    retryHeavySessionCount: number;
    crossProviderSessionCount: number;
    multiModelSessionCount: number;
  }> {
    const requestScope = buildRequestScope(filters);
    const sessionScope = buildSessionScope(filters, requestScope.params.length + 1);
    const sql = `
      with session_signals as (
        select
          sum(case when is_long_session then 1 else 0 end) as long_session_count,
          sum(case when is_high_token_session then 1 else 0 end) as high_token_session_count,
          sum(case when is_retry_heavy_session then 1 else 0 end) as retry_heavy_session_count,
          sum(case when is_cross_provider_session then 1 else 0 end) as cross_provider_session_count,
          sum(case when is_multi_model_session then 1 else 0 end) as multi_model_session_count
        from ${TABLES.adminAnalysisSessions} s
        where ${sessionScope.where.join(' and ')}
      )
      select
        sum(case when is_retry then 1 else 0 end) as retry_count,
        sum(case when is_failure then 1 else 0 end) as failure_count,
        sum(case when is_partial then 1 else 0 end) as partial_count,
        sum(case when is_high_token then 1 else 0 end) as high_token_count,
        sum(case when is_cross_provider_rescue then 1 else 0 end) as cross_provider_rescue_count,
        sum(case when has_tool_use then 1 else 0 end) as tool_use_count,
        session_signals.long_session_count,
        session_signals.high_token_session_count,
        session_signals.retry_heavy_session_count,
        session_signals.cross_provider_session_count,
        session_signals.multi_model_session_count
      from ${TABLES.adminAnalysisRequests}, session_signals
      where ${requestScope.where.join(' and ')}
    `;
    const params = [...requestScope.params, ...sessionScope.params];
    const row = (await this.db.query<Record<string, string>>(sql, params)).rows[0] ?? {};
    return {
      retryCount: Number(row.retry_count ?? 0),
      failureCount: Number(row.failure_count ?? 0),
      partialCount: Number(row.partial_count ?? 0),
      highTokenCount: Number(row.high_token_count ?? 0),
      crossProviderRescueCount: Number(row.cross_provider_rescue_count ?? 0),
      toolUseCount: Number(row.tool_use_count ?? 0),
      longSessionCount: Number(row.long_session_count ?? 0),
      highTokenSessionCount: Number(row.high_token_session_count ?? 0),
      retryHeavySessionCount: Number(row.retry_heavy_session_count ?? 0),
      crossProviderSessionCount: Number(row.cross_provider_session_count ?? 0),
      multiModelSessionCount: Number(row.multi_model_session_count ?? 0)
    };
  }

  listRequestSamples(filters: AdminAnalysisWindowSlice & {
    sampleSize: number;
  }): Promise<Array<Record<string, unknown>>> {
    const scope = buildRequestScope(filters);
    scope.params.push(clampLimit(filters.sampleSize, 200));
    const sql = `
      with ranked as (
        select
          *,
          row_number() over (partition by date_trunc('hour', started_at), task_category order by started_at desc, request_attempt_archive_id desc) as bucket_rank
        from ${TABLES.adminAnalysisRequests}
        where ${scope.where.join(' and ')}
      )
      select *
      from ranked
      where bucket_rank = 1
      order by started_at desc, request_attempt_archive_id desc
      limit $${scope.params.length}
    `;
    return this.db.query<Record<string, unknown>>(sql, scope.params).then((result) => result.rows);
  }

  listSessionSamples(filters: AdminAnalysisWindowSlice & {
    sampleSize: number;
  }): Promise<Array<Record<string, unknown>>> {
    const scope = buildSessionScope(filters);
    scope.params.push(clampLimit(filters.sampleSize, 200));
    const sql = `
      with ranked as (
        select
          s.*,
          row_number() over (partition by date_trunc('hour', last_activity_at), primary_task_category order by last_activity_at desc, session_key desc) as bucket_rank
        from ${TABLES.adminAnalysisSessions} s
        where ${scope.where.join(' and ')}
      )
      select *
      from ranked
      where bucket_rank = 1
      order by last_activity_at desc, session_key desc
      limit $${scope.params.length}
    `;
    return this.db.query<Record<string, unknown>>(sql, scope.params).then((result) => result.rows);
  }

  async getRequestDetail(requestId: string, attemptNo: number): Promise<{
    requestId: string;
    attemptNo: number;
    sessionKey: string;
    row: Record<string, unknown>;
  } | null> {
    const sql = `
      select *
      from ${TABLES.adminAnalysisRequests}
      where request_id = $1
        and attempt_no = $2
      order by started_at desc
      limit 1
    `;
    const result = await this.db.query<Record<string, unknown>>(sql, [requestId, attemptNo]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      requestId: String(row.request_id),
      attemptNo: Number(row.attempt_no),
      sessionKey: String(row.session_key),
      row
    };
  }

  async getSessionDetail(sessionKey: string): Promise<{
    sessionKey: string;
    row: Record<string, unknown>;
  } | null> {
    const sql = `
      select *
      from ${TABLES.adminAnalysisSessions}
      where session_key = $1
      limit 1
    `;
    const result = await this.db.query<Record<string, unknown>>(sql, [sessionKey]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      sessionKey: String(row.session_key),
      row
    };
  }

  async getCoverage(filters: Pick<AdminAnalysisWindowSlice, 'start' | 'end'>): Promise<{
    projectedRequestCount: number;
    pendingProjectionCount: number;
    firstProjectedAt: string | null;
    lastProjectedAt: string | null;
  }> {
    const sql = `
      select
        count(distinct r.request_attempt_archive_id)::bigint as projected_request_count,
        count(distinct o.request_attempt_archive_id)::bigint as pending_projection_count,
        min(r.started_at)::text as first_projected_at,
        max(r.started_at)::text as last_projected_at
      from ${TABLES.adminAnalysisRequests} r
      left join ${TABLES.adminAnalysisProjectionOutbox} o
        on o.request_attempt_archive_id = r.request_attempt_archive_id
        and o.projection_state = 'pending_projection'
      where r.started_at >= $1
        and r.started_at < $2
    `;
    const result = await this.db.query<{
      projected_request_count: string;
      pending_projection_count: string;
      first_projected_at: string | null;
      last_projected_at: string | null;
    }>(sql, [filters.start, filters.end]);
    const row = result.rows[0];
    return {
      projectedRequestCount: Number(row?.projected_request_count ?? 0),
      pendingProjectionCount: Number(row?.pending_projection_count ?? 0),
      firstProjectedAt: row?.first_projected_at ?? null,
      lastProjectedAt: row?.last_projected_at ?? null
    };
  }
}

function buildRequestScope(filters: AdminAnalysisWindowSlice, startIndex = 1) {
  const params: SqlValue[] = [filters.start, filters.end];
  const where = [`started_at >= $${startIndex}`, `started_at < $${startIndex + 1}`];

  if (filters.orgId) {
    params.push(filters.orgId);
    where.push(`org_id = $${startIndex + params.length - 1}`);
  }
  if (filters.sessionType) {
    params.push(filters.sessionType);
    where.push(`session_type = $${startIndex + params.length - 1}`);
  }
  if (filters.provider) {
    params.push(filters.provider);
    where.push(`provider = $${startIndex + params.length - 1}`);
  }
  if (filters.source) {
    params.push(filters.source);
    where.push(`source = $${startIndex + params.length - 1}`);
  }
  if (filters.taskCategory) {
    params.push(filters.taskCategory);
    where.push(`task_category = $${startIndex + params.length - 1}`);
  }
  if (filters.taskTag) {
    params.push(filters.taskTag);
    where.push(`task_tags @> array[$${startIndex + params.length - 1}]::text[]`);
  }

  return { params, where };
}

function buildSessionScope(filters: AdminAnalysisWindowSlice, startIndex = 1) {
  const params: SqlValue[] = [filters.start, filters.end];
  const where = [`s.last_activity_at >= $${startIndex}`, `s.last_activity_at < $${startIndex + 1}`];

  if (filters.orgId) {
    params.push(filters.orgId);
    where.push(`s.org_id = $${startIndex + params.length - 1}`);
  }
  if (filters.sessionType) {
    params.push(filters.sessionType);
    where.push(`s.session_type = $${startIndex + params.length - 1}`);
  }

  const requestFilters: string[] = [];
  if (filters.provider) {
    params.push(filters.provider);
    requestFilters.push(`sr.provider = $${startIndex + params.length - 1}`);
  }
  if (filters.source) {
    params.push(filters.source);
    requestFilters.push(`sr.source = $${startIndex + params.length - 1}`);
  }
  if (filters.taskCategory) {
    params.push(filters.taskCategory);
    requestFilters.push(`sr.task_category = $${startIndex + params.length - 1}`);
  }
  if (filters.taskTag) {
    params.push(filters.taskTag);
    requestFilters.push(`sr.task_tags @> array[$${startIndex + params.length - 1}]::text[]`);
  }

  if (requestFilters.length > 0) {
    where.push(`
      exists (
        select 1
        from ${TABLES.adminAnalysisRequests} sr
        where sr.session_key = s.session_key
          and ${requestFilters.join(' and ')}
      )
    `);
  }

  return { params, where };
}

function clampLimit(limit: number, max = 100): number {
  return Math.max(1, Math.min(max, Math.floor(limit)));
}
