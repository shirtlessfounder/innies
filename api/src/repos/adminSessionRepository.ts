import type { SqlClient, SqlValue } from './sqlClient.js';
import { TABLES } from './tableNames.js';

export type AdminSessionRow = {
  session_key: string;
  session_type: 'cli' | 'openclaw';
  grouping_basis: 'explicit_session_id' | 'explicit_run_id' | 'idle_gap' | 'request_fallback';
  org_id: string;
  api_key_id: string | null;
  source_session_id: string | null;
  source_run_id: string | null;
  started_at: string;
  ended_at: string;
  last_activity_at: string;
  request_count: number;
  attempt_count: number;
  input_tokens: number;
  output_tokens: number;
  provider_set: string[];
  model_set: string[];
  status_summary: Record<string, unknown>;
  preview_sample: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export class AdminSessionRepository {
  constructor(private readonly db: SqlClient) {}

  upsertSession(input: {
    sessionKey: string;
    sessionType: AdminSessionRow['session_type'];
    groupingBasis: AdminSessionRow['grouping_basis'];
    orgId: string;
    apiKeyId: string | null;
    sourceSessionId: string | null;
    sourceRunId: string | null;
    startedAt: Date;
    endedAt: Date;
    lastActivityAt: Date;
    requestCount: number;
    attemptCount: number;
    inputTokens: number;
    outputTokens: number;
    providerSet: string[];
    modelSet: string[];
    statusSummary: Record<string, unknown>;
    previewSample: Record<string, unknown> | null;
  }): Promise<AdminSessionRow> {
    const sql = `
      insert into ${TABLES.adminSessions} (
        session_key,
        session_type,
        grouping_basis,
        org_id,
        api_key_id,
        source_session_id,
        source_run_id,
        started_at,
        ended_at,
        last_activity_at,
        request_count,
        attempt_count,
        input_tokens,
        output_tokens,
        provider_set,
        model_set,
        status_summary,
        preview_sample,
        created_at,
        updated_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now(),now()
      )
      on conflict (session_key)
      do update set
        session_type = excluded.session_type,
        grouping_basis = excluded.grouping_basis,
        org_id = excluded.org_id,
        api_key_id = excluded.api_key_id,
        source_session_id = excluded.source_session_id,
        source_run_id = excluded.source_run_id,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        last_activity_at = excluded.last_activity_at,
        request_count = excluded.request_count,
        attempt_count = excluded.attempt_count,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        provider_set = excluded.provider_set,
        model_set = excluded.model_set,
        status_summary = excluded.status_summary,
        preview_sample = excluded.preview_sample,
        updated_at = now()
      returning *
    `;

    return this.expectOne(sql, [
      input.sessionKey,
      input.sessionType,
      input.groupingBasis,
      input.orgId,
      input.apiKeyId,
      input.sourceSessionId,
      input.sourceRunId,
      input.startedAt,
      input.endedAt,
      input.lastActivityAt,
      input.requestCount,
      input.attemptCount,
      input.inputTokens,
      input.outputTokens,
      input.providerSet,
      input.modelSet,
      input.statusSummary,
      input.previewSample
    ]);
  }

  async findBySessionKey(sessionKey: string): Promise<AdminSessionRow | null> {
    const sql = `
      select *
      from ${TABLES.adminSessions}
      where session_key = $1
      limit 1
    `;
    const result = await this.db.query<AdminSessionRow>(sql, [sessionKey]);
    return result.rows[0] ?? null;
  }

  async findLatestInLane(input: {
    orgId: string;
    apiKeyId: string | null;
    sessionType: AdminSessionRow['session_type'];
  }): Promise<AdminSessionRow | null> {
    const sql = `
      select *
      from ${TABLES.adminSessions}
      where org_id = $1
        and api_key_id is not distinct from $2
        and session_type = $3
      order by last_activity_at desc, session_key desc
      limit 1
    `;
    const result = await this.db.query<AdminSessionRow>(sql, [
      input.orgId,
      input.apiKeyId,
      input.sessionType
    ]);
    return result.rows[0] ?? null;
  }

  private async expectOne(sql: string, params: SqlValue[]): Promise<AdminSessionRow> {
    const result = await this.db.query<AdminSessionRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one admin session row');
    }
    return result.rows[0];
  }
}
