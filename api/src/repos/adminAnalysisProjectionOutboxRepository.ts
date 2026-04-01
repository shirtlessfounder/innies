import type { IdFactory } from './idFactory.js';
import { uuidV4 } from './idFactory.js';
import type { SqlClient, SqlValue } from './sqlClient.js';
import { TABLES } from './tableNames.js';

export type AdminAnalysisProjectionOutboxRow = {
  id: string;
  request_attempt_archive_id: string;
  request_id: string;
  attempt_no: number;
  org_id: string;
  api_key_id: string | null;
  projection_state: 'pending_projection' | 'projected' | 'needs_operator_correction';
  retry_count: number;
  next_attempt_at: string | null;
  last_attempted_at: string | null;
  processed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export class AdminAnalysisProjectionOutboxRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  enqueueAttempt(input: {
    requestAttemptArchiveId: string;
    requestId: string;
    attemptNo: number;
    orgId: string;
    apiKeyId: string | null;
  }): Promise<AdminAnalysisProjectionOutboxRow> {
    const sql = `
      insert into ${TABLES.adminAnalysisProjectionOutbox} (
        id,
        request_attempt_archive_id,
        request_id,
        attempt_no,
        org_id,
        api_key_id,
        projection_state,
        retry_count,
        next_attempt_at,
        last_attempted_at,
        processed_at,
        last_error,
        created_at,
        updated_at
      ) values (
        $1,$2,$3,$4,$5,$6,'pending_projection',0,now(),null,null,null,now(),now()
      )
      on conflict (request_attempt_archive_id)
      do update set
        updated_at = now()
      returning *
    `;

    return this.expectOne(sql, [
      this.createId(),
      input.requestAttemptArchiveId,
      input.requestId,
      input.attemptNo,
      input.orgId,
      input.apiKeyId
    ]);
  }

  listDue(input: {
    now: Date;
    limit: number;
  }): Promise<AdminAnalysisProjectionOutboxRow[]> {
    const sql = `
      select *
      from ${TABLES.adminAnalysisProjectionOutbox}
      where projection_state = 'pending_projection'
        and next_attempt_at <= $1
      order by next_attempt_at asc, created_at asc, request_attempt_archive_id asc
      limit $2
    `;

    return this.db.query<AdminAnalysisProjectionOutboxRow>(sql, [
      input.now,
      clampLimit(input.limit)
    ]).then((result) => result.rows);
  }

  markProjected(input: {
    requestAttemptArchiveId: string;
    projectedAt: Date;
  }): Promise<AdminAnalysisProjectionOutboxRow> {
    const sql = `
      update ${TABLES.adminAnalysisProjectionOutbox}
      set
        projection_state = 'projected',
        retry_count = 0,
        last_attempted_at = $2,
        next_attempt_at = $2,
        processed_at = $2,
        last_error = null,
        updated_at = now()
      where request_attempt_archive_id = $1
      returning *
    `;

    return this.expectOne(sql, [
      input.requestAttemptArchiveId,
      input.projectedAt
    ]);
  }

  markPendingRetry(input: {
    requestAttemptArchiveId: string;
    retryCount: number;
    lastAttemptedAt: Date;
    nextAttemptAt: Date;
    lastError: string;
  }): Promise<AdminAnalysisProjectionOutboxRow> {
    const sql = `
      update ${TABLES.adminAnalysisProjectionOutbox}
      set
        projection_state = 'pending_projection',
        retry_count = $2,
        last_attempted_at = $3,
        next_attempt_at = $4,
        processed_at = null,
        last_error = $5,
        updated_at = now()
      where request_attempt_archive_id = $1
      returning *
    `;

    return this.expectOne(sql, [
      input.requestAttemptArchiveId,
      input.retryCount,
      input.lastAttemptedAt,
      input.nextAttemptAt,
      input.lastError
    ]);
  }

  markNeedsOperatorCorrection(input: {
    requestAttemptArchiveId: string;
    retryCount: number;
    lastAttemptedAt: Date;
    lastError: string;
  }): Promise<AdminAnalysisProjectionOutboxRow> {
    const sql = `
      update ${TABLES.adminAnalysisProjectionOutbox}
      set
        projection_state = 'needs_operator_correction',
        retry_count = $2,
        last_attempted_at = $3,
        next_attempt_at = null,
        processed_at = null,
        last_error = $4,
        updated_at = now()
      where request_attempt_archive_id = $1
      returning *
    `;

    return this.expectOne(sql, [
      input.requestAttemptArchiveId,
      input.retryCount,
      input.lastAttemptedAt,
      input.lastError
    ]);
  }

  async countPendingInWindow(input: {
    start: Date;
    end: Date;
  }): Promise<number> {
    const sql = `
      select count(*)::bigint as pending_count
      from ${TABLES.adminAnalysisProjectionOutbox} o
      inner join ${TABLES.requestAttemptArchives} a
        on a.id = o.request_attempt_archive_id
      where o.projection_state = 'pending_projection'
        and a.started_at >= $1
        and a.started_at < $2
    `;
    const result = await this.db.query<{ pending_count: string | number }>(sql, [
      input.start,
      input.end
    ]);
    return Number(result.rows[0]?.pending_count ?? 0);
  }

  async enqueueMissingArchivedAttempts(input: {
    start: Date;
    end: Date;
    limit: number;
  }): Promise<number> {
    return this.db.transaction(async (tx) => {
      const candidateSql = `
        select
          a.id,
          a.request_id,
          a.attempt_no,
          a.org_id,
          a.api_key_id
        from ${TABLES.requestAttemptArchives} a
        left join ${TABLES.routingEvents} re
          on re.org_id = a.org_id
          and re.request_id = a.request_id
          and re.attempt_no = a.attempt_no
        left join ${TABLES.adminAnalysisProjectionOutbox} o
          on o.request_attempt_archive_id = a.id
        left join ${TABLES.adminAnalysisRequests} r
          on r.request_attempt_archive_id = a.id
        where a.started_at >= $1
          and a.started_at < $2
          and o.request_attempt_archive_id is null
          and r.request_attempt_archive_id is null
          and (
            nullif(re.route_decision->>'request_source', '') in ('openclaw', 'cli-claude', 'cli-codex')
            or (
              nullif(re.route_decision->>'request_source', '') is null
              and (
                nullif(re.route_decision->>'provider_selection_reason', '') = 'cli_provider_pinned'
                or coalesce(nullif(re.route_decision->>'openclaw_run_id', ''), a.openclaw_run_id) is not null
                or coalesce(nullif(re.route_decision->>'openclaw_session_id', ''), a.openclaw_session_id) is not null
              )
            )
          )
        order by a.started_at asc, a.id asc
        limit $3
      `;
      const candidates = await tx.query<Array<{
        id: string;
        request_id: string;
        attempt_no: number;
        org_id: string;
        api_key_id: string | null;
      }>[number]>(candidateSql, [
        input.start,
        input.end,
        clampLimit(input.limit)
      ]);

      if (candidates.rowCount === 0 || candidates.rows.length === 0) {
        return 0;
      }

      const payload = candidates.rows.map((row) => ({
        id: this.createId(),
        request_attempt_archive_id: row.id,
        request_id: row.request_id,
        attempt_no: row.attempt_no,
        org_id: row.org_id,
        api_key_id: row.api_key_id
      }));
      const insertSql = `
        insert into ${TABLES.adminAnalysisProjectionOutbox} (
          id,
          request_attempt_archive_id,
          request_id,
          attempt_no,
          org_id,
          api_key_id,
          projection_state,
          retry_count,
          next_attempt_at,
          last_attempted_at,
          processed_at,
          last_error,
          created_at,
          updated_at
        )
        select
          payload.id::uuid,
          payload.request_attempt_archive_id::uuid,
          payload.request_id,
          payload.attempt_no,
          payload.org_id::uuid,
          payload.api_key_id::uuid,
          'pending_projection',
          0,
          now(),
          null,
          null,
          null,
          now(),
          now()
        from json_to_recordset($1::json) as payload(
          id text,
          request_attempt_archive_id text,
          request_id text,
          attempt_no integer,
          org_id text,
          api_key_id text
        )
        on conflict (request_attempt_archive_id)
        do nothing
      `;
      const result = await tx.query(insertSql, [JSON.stringify(payload)]);
      return result.rowCount;
    });
  }

  async requeueWaitingForSessionProjection(input: {
    start: Date;
    end: Date;
    limit: number;
  }): Promise<number> {
    const sql = `
      with candidates as (
        select o.request_attempt_archive_id
        from ${TABLES.adminAnalysisProjectionOutbox} o
        inner join ${TABLES.requestAttemptArchives} a
          on a.id = o.request_attempt_archive_id
        where o.projection_state = 'needs_operator_correction'
          and o.last_error like 'admin analysis projection waiting for admin session %'
          and a.started_at >= $1
          and a.started_at < $2
        order by a.started_at asc, o.request_attempt_archive_id asc
        limit $3
      )
      update ${TABLES.adminAnalysisProjectionOutbox} o
      set
        projection_state = 'pending_projection',
        retry_count = 0,
        next_attempt_at = now(),
        last_attempted_at = null,
        processed_at = null,
        last_error = null,
        updated_at = now()
      from candidates
      where candidates.request_attempt_archive_id = o.request_attempt_archive_id
      returning o.request_attempt_archive_id
    `;
    const result = await this.db.query(sql, [
      input.start,
      input.end,
      clampLimit(input.limit)
    ]);
    return result.rowCount;
  }

  private async expectOne(sql: string, params: SqlValue[]): Promise<AdminAnalysisProjectionOutboxRow> {
    const result = await this.db.query<AdminAnalysisProjectionOutboxRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one admin analysis projection outbox row');
    }
    return result.rows[0];
  }
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(200, Math.floor(limit)));
}
