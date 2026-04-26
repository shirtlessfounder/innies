import type { SqlClient, SqlValue } from './sqlClient.js';
import { TABLES } from './tableNames.js';

export type AdminAnalysisTaskCategory =
  | 'debugging'
  | 'feature_building'
  | 'code_review'
  | 'research'
  | 'ops'
  | 'writing'
  | 'data_analysis'
  | 'other';

export type AdminAnalysisRequestRow = {
  request_attempt_archive_id: string;
  request_id: string;
  attempt_no: number;
  session_key: string;
  org_id: string;
  api_key_id: string | null;
  session_type: 'cli' | 'openclaw';
  grouping_basis: 'explicit_session_id' | 'explicit_run_id' | 'idle_gap' | 'request_fallback';
  source: string;
  provider: string;
  model: string;
  status: 'success' | 'failed' | 'partial';
  started_at: string;
  completed_at: string | null;
  input_tokens: number;
  output_tokens: number;
  user_message_preview: string | null;
  assistant_text_preview: string | null;
  task_category: AdminAnalysisTaskCategory;
  task_tags: string[];
  is_retry: boolean;
  is_failure: boolean;
  is_partial: boolean;
  is_high_token: boolean;
  is_cross_provider_rescue: boolean;
  has_tool_use: boolean;
  interestingness_score: number;
  created_at: string;
  updated_at: string;
};

export type AdminAnalysisSessionRollupRow = {
  session_key: string;
  org_id: string;
  session_type: AdminAnalysisRequestRow['session_type'];
  grouping_basis: AdminAnalysisRequestRow['grouping_basis'];
  started_at: string;
  ended_at: string;
  last_activity_at: string;
  request_count: number | string;
  attempt_count: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  primary_task_category: AdminAnalysisTaskCategory;
  task_category_breakdown: Record<string, unknown>;
  task_tag_set: string[];
  is_long_session: boolean;
  is_high_token_session: boolean;
  is_retry_heavy_session: boolean;
  is_cross_provider_session: boolean;
  is_multi_model_session: boolean;
  interestingness_score: number | string;
};

export class AdminAnalysisRequestRepository {
  constructor(private readonly db: SqlClient) {}

  upsertRequest(input: {
    requestAttemptArchiveId: string;
    requestId: string;
    attemptNo: number;
    sessionKey: string;
    orgId: string;
    apiKeyId: string | null;
    sessionType: AdminAnalysisRequestRow['session_type'];
    groupingBasis: AdminAnalysisRequestRow['grouping_basis'];
    source: string;
    provider: string;
    model: string;
    status: AdminAnalysisRequestRow['status'];
    startedAt: Date;
    completedAt: Date | null;
    inputTokens: number;
    outputTokens: number;
    userMessagePreview: string | null;
    assistantTextPreview: string | null;
    taskCategory: AdminAnalysisTaskCategory;
    taskTags: string[];
    isRetry: boolean;
    isFailure: boolean;
    isPartial: boolean;
    isHighToken: boolean;
    isCrossProviderRescue: boolean;
    hasToolUse: boolean;
    interestingnessScore: number;
  }): Promise<AdminAnalysisRequestRow> {
    const sql = `
      insert into ${TABLES.adminAnalysisRequests} (
        request_attempt_archive_id,
        request_id,
        attempt_no,
        session_key,
        org_id,
        api_key_id,
        session_type,
        grouping_basis,
        source,
        provider,
        model,
        status,
        started_at,
        completed_at,
        input_tokens,
        output_tokens,
        user_message_preview,
        assistant_text_preview,
        task_category,
        task_tags,
        is_retry,
        is_failure,
        is_partial,
        is_high_token,
        is_cross_provider_rescue,
        has_tool_use,
        interestingness_score,
        created_at,
        updated_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,now(),now()
      )
      on conflict (request_attempt_archive_id)
      do update set
        request_id = excluded.request_id,
        attempt_no = excluded.attempt_no,
        session_key = excluded.session_key,
        org_id = excluded.org_id,
        api_key_id = excluded.api_key_id,
        session_type = excluded.session_type,
        grouping_basis = excluded.grouping_basis,
        source = excluded.source,
        provider = excluded.provider,
        model = excluded.model,
        status = excluded.status,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        user_message_preview = excluded.user_message_preview,
        assistant_text_preview = excluded.assistant_text_preview,
        task_category = excluded.task_category,
        task_tags = excluded.task_tags,
        is_retry = excluded.is_retry,
        is_failure = excluded.is_failure,
        is_partial = excluded.is_partial,
        is_high_token = excluded.is_high_token,
        is_cross_provider_rescue = excluded.is_cross_provider_rescue,
        has_tool_use = excluded.has_tool_use,
        interestingness_score = excluded.interestingness_score,
        updated_at = now()
      returning *
    `;

    return this.expectOne(sql, [
      input.requestAttemptArchiveId,
      input.requestId,
      input.attemptNo,
      input.sessionKey,
      input.orgId,
      input.apiKeyId,
      input.sessionType,
      input.groupingBasis,
      input.source,
      input.provider,
      input.model,
      input.status,
      input.startedAt,
      input.completedAt,
      input.inputTokens,
      input.outputTokens,
      input.userMessagePreview,
      input.assistantTextPreview,
      input.taskCategory,
      input.taskTags,
      input.isRetry,
      input.isFailure,
      input.isPartial,
      input.isHighToken,
      input.isCrossProviderRescue,
      input.hasToolUse,
      input.interestingnessScore
    ]);
  }

  async findByArchiveId(requestAttemptArchiveId: string): Promise<AdminAnalysisRequestRow | null> {
    const sql = `
      select *
      from ${TABLES.adminAnalysisRequests}
      where request_attempt_archive_id = $1
      limit 1
    `;
    const result = await this.db.query<AdminAnalysisRequestRow>(sql, [requestAttemptArchiveId]);
    return result.rows[0] ?? null;
  }

  listBySessionKey(sessionKey: string): Promise<AdminAnalysisRequestRow[]> {
    const sql = `
      select *
      from ${TABLES.adminAnalysisRequests}
      where session_key = $1
      order by started_at asc, request_id asc, attempt_no asc
    `;
    return this.db.query<AdminAnalysisRequestRow>(sql, [sessionKey]).then((result) => result.rows);
  }

  async loadSessionRollup(sessionKey: string): Promise<AdminAnalysisSessionRollupRow | null> {
    const sql = `
      with scoped as (
        select *
        from ${TABLES.adminAnalysisRequests}
        where session_key = $1
      ),
      category_stats as (
        select
          task_category,
          count(*)::int as request_count,
          min(started_at) as first_started_at,
          min(request_attempt_archive_id::text) as first_archive_id
        from scoped
        group by task_category
      ),
      tag_set as (
        select coalesce(array_agg(distinct tag order by tag), '{}'::text[]) as tags
        from scoped
        cross join lateral unnest(task_tags) as tag
      ),
      rollup as (
        select
          $1::text as session_key,
          (array_agg(org_id order by started_at asc, request_attempt_archive_id asc))[1] as org_id,
          (array_agg(session_type order by started_at asc, request_attempt_archive_id asc))[1] as session_type,
          (array_agg(grouping_basis order by started_at asc, request_attempt_archive_id asc))[1] as grouping_basis,
          min(started_at) as started_at,
          max(coalesce(completed_at, started_at)) as ended_at,
          max(coalesce(completed_at, started_at)) as last_activity_at,
          count(distinct request_id)::int as request_count,
          count(*)::int as attempt_count,
          coalesce(sum(input_tokens), 0) as input_tokens,
          coalesce(sum(output_tokens), 0) as output_tokens,
          coalesce(sum(interestingness_score), 0) as interestingness_score,
          bool_or(is_retry) as is_retry_heavy_session,
          count(distinct provider) > 1 as is_cross_provider_session,
          count(distinct model) > 1 as is_multi_model_session
        from scoped
      )
      select
        rollup.session_key,
        rollup.org_id,
        rollup.session_type,
        rollup.grouping_basis,
        rollup.started_at,
        rollup.ended_at,
        rollup.last_activity_at,
        rollup.request_count,
        rollup.attempt_count,
        rollup.input_tokens,
        rollup.output_tokens,
        (
          select task_category
          from category_stats
          order by request_count desc, first_started_at asc, first_archive_id asc
          limit 1
        ) as primary_task_category,
        coalesce(
          (
            select jsonb_object_agg(task_category, request_count)
            from category_stats
          ),
          '{}'::jsonb
        ) as task_category_breakdown,
        tag_set.tags as task_tag_set,
        extract(epoch from (rollup.ended_at - rollup.started_at)) * 1000 >= 1800000 as is_long_session,
        rollup.input_tokens + rollup.output_tokens >= 40000 as is_high_token_session,
        rollup.is_retry_heavy_session,
        rollup.is_cross_provider_session,
        rollup.is_multi_model_session,
        rollup.interestingness_score
      from rollup
      cross join tag_set
      where rollup.attempt_count > 0
    `;
    const result = await this.db.query<AdminAnalysisSessionRollupRow>(sql, [sessionKey]);
    return result.rows[0] ?? null;
  }

  private async expectOne(sql: string, params: SqlValue[]): Promise<AdminAnalysisRequestRow> {
    const result = await this.db.query<AdminAnalysisRequestRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one admin analysis request row');
    }
    return result.rows[0];
  }
}
