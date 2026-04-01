import type { SqlClient, SqlValue } from './sqlClient.js';
import type { AdminAnalysisTaskCategory } from './adminAnalysisRequestRepository.js';
import { TABLES } from './tableNames.js';

export type AdminAnalysisSessionRow = {
  session_key: string;
  org_id: string;
  session_type: 'cli' | 'openclaw';
  grouping_basis: 'explicit_session_id' | 'explicit_run_id' | 'idle_gap' | 'request_fallback';
  started_at: string;
  ended_at: string;
  last_activity_at: string;
  request_count: number;
  attempt_count: number;
  input_tokens: number;
  output_tokens: number;
  primary_task_category: AdminAnalysisTaskCategory;
  task_category_breakdown: Record<string, unknown>;
  task_tag_set: string[];
  is_long_session: boolean;
  is_high_token_session: boolean;
  is_retry_heavy_session: boolean;
  is_cross_provider_session: boolean;
  is_multi_model_session: boolean;
  interestingness_score: number;
  created_at: string;
  updated_at: string;
};

export class AdminAnalysisSessionRepository {
  constructor(private readonly db: SqlClient) {}

  upsertSession(input: {
    sessionKey: string;
    orgId: string;
    sessionType: AdminAnalysisSessionRow['session_type'];
    groupingBasis: AdminAnalysisSessionRow['grouping_basis'];
    startedAt: Date;
    endedAt: Date;
    lastActivityAt: Date;
    requestCount: number;
    attemptCount: number;
    inputTokens: number;
    outputTokens: number;
    primaryTaskCategory: AdminAnalysisTaskCategory;
    taskCategoryBreakdown: Record<string, unknown>;
    taskTagSet: string[];
    isLongSession: boolean;
    isHighTokenSession: boolean;
    isRetryHeavySession: boolean;
    isCrossProviderSession: boolean;
    isMultiModelSession: boolean;
    interestingnessScore: number;
  }): Promise<AdminAnalysisSessionRow> {
    const sql = `
      insert into ${TABLES.adminAnalysisSessions} (
        session_key,
        org_id,
        session_type,
        grouping_basis,
        started_at,
        ended_at,
        last_activity_at,
        request_count,
        attempt_count,
        input_tokens,
        output_tokens,
        primary_task_category,
        task_category_breakdown,
        task_tag_set,
        is_long_session,
        is_high_token_session,
        is_retry_heavy_session,
        is_cross_provider_session,
        is_multi_model_session,
        interestingness_score,
        created_at,
        updated_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now(),now()
      )
      on conflict (session_key)
      do update set
        org_id = excluded.org_id,
        session_type = excluded.session_type,
        grouping_basis = excluded.grouping_basis,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        last_activity_at = excluded.last_activity_at,
        request_count = excluded.request_count,
        attempt_count = excluded.attempt_count,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        primary_task_category = excluded.primary_task_category,
        task_category_breakdown = excluded.task_category_breakdown,
        task_tag_set = excluded.task_tag_set,
        is_long_session = excluded.is_long_session,
        is_high_token_session = excluded.is_high_token_session,
        is_retry_heavy_session = excluded.is_retry_heavy_session,
        is_cross_provider_session = excluded.is_cross_provider_session,
        is_multi_model_session = excluded.is_multi_model_session,
        interestingness_score = excluded.interestingness_score,
        updated_at = now()
      returning *
    `;

    return this.expectOne(sql, [
      input.sessionKey,
      input.orgId,
      input.sessionType,
      input.groupingBasis,
      input.startedAt,
      input.endedAt,
      input.lastActivityAt,
      input.requestCount,
      input.attemptCount,
      input.inputTokens,
      input.outputTokens,
      input.primaryTaskCategory,
      input.taskCategoryBreakdown,
      input.taskTagSet,
      input.isLongSession,
      input.isHighTokenSession,
      input.isRetryHeavySession,
      input.isCrossProviderSession,
      input.isMultiModelSession,
      input.interestingnessScore
    ]);
  }

  async findBySessionKey(sessionKey: string): Promise<AdminAnalysisSessionRow | null> {
    const sql = `
      select *
      from ${TABLES.adminAnalysisSessions}
      where session_key = $1
      limit 1
    `;
    const result = await this.db.query<AdminAnalysisSessionRow>(sql, [sessionKey]);
    return result.rows[0] ?? null;
  }

  private async expectOne(sql: string, params: SqlValue[]): Promise<AdminAnalysisSessionRow> {
    const result = await this.db.query<AdminAnalysisSessionRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one admin analysis session row');
    }
    return result.rows[0];
  }
}
