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

  private async expectOne(sql: string, params: SqlValue[]): Promise<AdminAnalysisRequestRow> {
    const result = await this.db.query<AdminAnalysisRequestRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one admin analysis request row');
    }
    return result.rows[0];
  }
}
