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

export type AdminSessionProjectionRollupRow = {
  session_key: string;
  started_at: string;
  ended_at: string;
  last_activity_at: string;
  request_count: number;
  attempt_count: number;
  input_tokens: number;
  output_tokens: number;
  provider_set: string[];
  model_set: string[];
  status_summary: Record<string, number>;
  preview_sample: Record<string, unknown> | null;
};

type AdminSessionProjectionRollupDbRow = {
  session_key: string;
  started_at: string;
  ended_at: string;
  last_activity_at: string;
  request_count: number | string;
  attempt_count: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  provider_set: string[];
  model_set: string[];
  status_summary: Record<string, unknown> | null;
  preview_sample: Record<string, unknown> | null;
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

  async loadProjectionRollup(sessionKey: string): Promise<AdminSessionProjectionRollupRow | null> {
    const sql = `
      with linked as (
        select
          sa.session_key,
          sa.request_attempt_archive_id,
          sa.request_id,
          sa.attempt_no,
          sa.event_time,
          sa.provider,
          sa.model,
          sa.status,
          a.started_at,
          coalesce(a.completed_at, a.started_at) as ended_at,
          coalesce(ul.input_tokens, 0) as input_tokens,
          coalesce(ul.output_tokens, 0) as output_tokens,
          rl.prompt_preview,
          rl.response_preview
        from ${TABLES.adminSessionAttempts} sa
        join ${TABLES.requestAttemptArchives} a
          on a.id = sa.request_attempt_archive_id
        left join ${TABLES.usageLedger} ul
          on ul.org_id = a.org_id
          and ul.request_id = a.request_id
          and ul.attempt_no = a.attempt_no
          and ul.entry_type = 'usage'
        left join ${TABLES.requestLog} rl
          on rl.org_id = a.org_id
          and rl.request_id = a.request_id
          and rl.attempt_no = a.attempt_no
        where sa.session_key = $1
      ),
      rollup as (
        select
          $1::text as session_key,
          min(started_at) as started_at,
          max(ended_at) as ended_at,
          max(event_time) as last_activity_at,
          count(distinct request_id)::int as request_count,
          count(*)::int as attempt_count,
          coalesce(sum(input_tokens), 0) as input_tokens,
          coalesce(sum(output_tokens), 0) as output_tokens,
          coalesce(array_agg(distinct provider order by provider), '{}'::text[]) as provider_set,
          coalesce(array_agg(distinct model order by model), '{}'::text[]) as model_set,
          jsonb_strip_nulls(jsonb_build_object(
            'success', nullif(count(*) filter (where status = 'success'), 0),
            'failed', nullif(count(*) filter (where status = 'failed'), 0),
            'partial', nullif(count(*) filter (where status = 'partial'), 0)
          )) as status_summary
        from linked
      ),
      latest as (
        select
          request_id,
          attempt_no,
          prompt_preview,
          response_preview
        from linked
        order by event_time desc, request_id desc, attempt_no desc, request_attempt_archive_id desc
        limit 1
      )
      select
        rollup.*,
        case
          when latest.request_id is null then null
          when latest.prompt_preview is null and latest.response_preview is null then null
          else jsonb_build_object(
            'promptPreview', latest.prompt_preview,
            'responsePreview', latest.response_preview,
            'latestRequestId', latest.request_id,
            'latestAttemptNo', latest.attempt_no
          )
        end as preview_sample
      from rollup
      left join latest on true
      where rollup.attempt_count > 0
    `;
    const result = await this.db.query<AdminSessionProjectionRollupDbRow>(sql, [sessionKey]);
    const row = result.rows[0];
    return row ? normalizeProjectionRollup(row) : null;
  }

  private async expectOne(sql: string, params: SqlValue[]): Promise<AdminSessionRow> {
    const result = await this.db.query<AdminSessionRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one admin session row');
    }
    return result.rows[0];
  }
}

function normalizeProjectionRollup(row: AdminSessionProjectionRollupDbRow): AdminSessionProjectionRollupRow {
  return {
    session_key: row.session_key,
    started_at: row.started_at,
    ended_at: row.ended_at,
    last_activity_at: row.last_activity_at,
    request_count: parseIntegerLike(row.request_count, 'request_count'),
    attempt_count: parseIntegerLike(row.attempt_count, 'attempt_count'),
    input_tokens: parseIntegerLike(row.input_tokens, 'input_tokens'),
    output_tokens: parseIntegerLike(row.output_tokens, 'output_tokens'),
    provider_set: [...row.provider_set],
    model_set: [...row.model_set],
    status_summary: normalizeStatusSummary(row.status_summary),
    preview_sample: row.preview_sample ?? null
  };
}

function normalizeStatusSummary(current: Record<string, unknown> | null | undefined): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const [key, value] of Object.entries(current ?? {})) {
    const count = parseIntegerLike(value as number | string, key);
    if (count > 0) {
      summary[key] = count;
    }
  }
  return summary;
}

function parseIntegerLike(value: number | string, field: string): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`expected ${field} to be a safe integer`);
  }
  return parsed;
}
