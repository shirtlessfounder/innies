import type { SqlValue, TransactionContext } from './sqlClient.js';
import { TABLES } from './tableNames.js';
import { LIVE_LANE_PROJECTION_VERSION } from '../services/liveLanes/liveLaneTypes.js';

export type LiveLaneProjectionState = 'pending_projection' | 'projected' | 'needs_operator_correction';

export type LiveLaneProjectionOutboxRow = {
  request_attempt_archive_id: string;
  request_id: string;
  attempt_no: number;
  state: LiveLaneProjectionState;
  retry_count: number;
  available_at: string;
  last_attempt_at: string | null;
  next_retry_at: string | null;
  projected_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  projection_version: number;
  created_at: string;
  updated_at: string;
};

type Queryable = Pick<TransactionContext, 'query'>;

export class LiveLaneProjectionOutboxRepository {
  constructor(private readonly db: Queryable) {}

  async enqueue(input: {
    requestAttemptArchiveId: string;
    requestId: string;
    attemptNo: number;
    availableAt?: Date | null;
    projectionVersion?: number;
  }): Promise<LiveLaneProjectionOutboxRow> {
    const sql = `
      insert into ${TABLES.liveLaneProjectionOutbox} (
        request_attempt_archive_id,
        request_id,
        attempt_no,
        state,
        retry_count,
        available_at,
        last_attempt_at,
        next_retry_at,
        projected_at,
        last_error_code,
        last_error_message,
        projection_version,
        created_at,
        updated_at
      ) values (
        $1,$2,$3,$4,0,$5,null,null,null,null,null,$6,now(),now()
      )
      on conflict (request_attempt_archive_id)
      do update set
        request_id = excluded.request_id,
        attempt_no = excluded.attempt_no,
        state = excluded.state,
        retry_count = 0,
        available_at = excluded.available_at,
        last_attempt_at = null,
        next_retry_at = null,
        projected_at = null,
        last_error_code = null,
        last_error_message = null,
        projection_version = excluded.projection_version,
        updated_at = now()
      returning *
    `;

    return this.expectOne(sql, [
      input.requestAttemptArchiveId,
      input.requestId,
      input.attemptNo,
      'pending_projection',
      input.availableAt ?? new Date(),
      input.projectionVersion ?? LIVE_LANE_PROJECTION_VERSION
    ]);
  }

  async enqueueJoinedAttemptByRequestKey(input: {
    orgId: string;
    requestId: string;
    attemptNo: number;
    availableAt?: Date | null;
    projectionVersion?: number;
  }): Promise<LiveLaneProjectionOutboxRow | null> {
    const sql = `
      insert into ${TABLES.liveLaneProjectionOutbox} (
        request_attempt_archive_id,
        request_id,
        attempt_no,
        state,
        retry_count,
        available_at,
        last_attempt_at,
        next_retry_at,
        projected_at,
        last_error_code,
        last_error_message,
        projection_version,
        created_at,
        updated_at
      )
      select
        rl.id,
        rl.request_id,
        rl.attempt_no,
        'pending_projection',
        0,
        $4,
        null,
        null,
        null,
        null,
        null,
        $5,
        now(),
        now()
      from ${TABLES.requestLog} rl
      join ${TABLES.routingEvents} re
        on re.org_id = rl.org_id
       and re.request_id = rl.request_id
       and re.attempt_no = rl.attempt_no
      where rl.org_id = $1
        and rl.request_id = $2
        and rl.attempt_no = $3
      on conflict (request_attempt_archive_id)
      do update set
        request_id = excluded.request_id,
        attempt_no = excluded.attempt_no,
        state = excluded.state,
        retry_count = 0,
        available_at = excluded.available_at,
        last_attempt_at = null,
        next_retry_at = null,
        projected_at = null,
        last_error_code = null,
        last_error_message = null,
        projection_version = excluded.projection_version,
        updated_at = now()
      returning *
    `;

    return this.expectZeroOrOne(sql, [
      input.orgId,
      input.requestId,
      input.attemptNo,
      input.availableAt ?? new Date(),
      input.projectionVersion ?? LIVE_LANE_PROJECTION_VERSION
    ]);
  }

  backfillJoinedAttempts(input: {
    limit: number;
    availableAt?: Date | null;
    projectionVersion?: number;
  }): Promise<LiveLaneProjectionOutboxRow[]> {
    const sql = `
      with joined_attempts as (
        select
          rl.id as request_attempt_archive_id,
          rl.request_id,
          rl.attempt_no
        from ${TABLES.requestLog} rl
        join ${TABLES.routingEvents} re
          on re.org_id = rl.org_id
         and re.request_id = rl.request_id
         and re.attempt_no = rl.attempt_no
        left join ${TABLES.liveLaneProjectionOutbox} outbox
          on outbox.request_attempt_archive_id = rl.id
        where outbox.request_attempt_archive_id is null
        order by rl.created_at asc, rl.id asc
        limit $2
      )
      insert into ${TABLES.liveLaneProjectionOutbox} (
        request_attempt_archive_id,
        request_id,
        attempt_no,
        state,
        retry_count,
        available_at,
        last_attempt_at,
        next_retry_at,
        projected_at,
        last_error_code,
        last_error_message,
        projection_version,
        created_at,
        updated_at
      )
      select
        joined_attempts.request_attempt_archive_id,
        joined_attempts.request_id,
        joined_attempts.attempt_no,
        'pending_projection',
        0,
        $1,
        null,
        null,
        null,
        null,
        null,
        $3,
        now(),
        now()
      from joined_attempts
      on conflict (request_attempt_archive_id) do nothing
      returning *
    `;

    return this.db.query<LiveLaneProjectionOutboxRow>(sql, [
      input.availableAt ?? new Date(),
      Math.max(1, Math.min(500, Math.floor(input.limit))),
      input.projectionVersion ?? LIVE_LANE_PROJECTION_VERSION
    ]).then((result) => result.rows);
  }

  listDueForProjection(input: {
    now: Date;
    limit: number;
  }): Promise<LiveLaneProjectionOutboxRow[]> {
    const sql = `
      select *
      from ${TABLES.liveLaneProjectionOutbox}
      where state = 'pending_projection'
        and available_at <= $1
        and (next_retry_at is null or next_retry_at <= $1)
      order by coalesce(next_retry_at, available_at) asc, request_attempt_archive_id asc
      limit $2
    `;

    return this.db.query<LiveLaneProjectionOutboxRow>(sql, [
      input.now,
      Math.max(1, Math.min(500, Math.floor(input.limit)))
    ]).then((result) => result.rows);
  }

  async markProjected(input: {
    requestAttemptArchiveId: string;
  }): Promise<LiveLaneProjectionOutboxRow> {
    const sql = `
      update ${TABLES.liveLaneProjectionOutbox}
      set
        state = $2,
        last_attempt_at = now(),
        projected_at = now(),
        last_error_code = null,
        last_error_message = null,
        next_retry_at = null,
        updated_at = now()
      where request_attempt_archive_id = $1
      returning *
    `;

    return this.expectOne(sql, [
      input.requestAttemptArchiveId,
      'projected'
    ]);
  }

  async markPendingRetry(input: {
    requestAttemptArchiveId: string;
    retryCount: number;
    lastAttemptAt: Date;
    nextRetryAt: Date;
    lastErrorCode: string;
    lastErrorMessage: string;
  }): Promise<LiveLaneProjectionOutboxRow> {
    const sql = `
      update ${TABLES.liveLaneProjectionOutbox}
      set
        state = $2,
        retry_count = $3,
        last_attempt_at = $4,
        next_retry_at = $5,
        last_error_code = $6,
        last_error_message = $7,
        updated_at = now()
      where request_attempt_archive_id = $1
      returning *
    `;

    return this.expectOne(sql, [
      input.requestAttemptArchiveId,
      'pending_projection',
      input.retryCount,
      input.lastAttemptAt,
      input.nextRetryAt,
      input.lastErrorCode,
      input.lastErrorMessage
    ]);
  }

  async markNeedsOperatorCorrection(input: {
    requestAttemptArchiveId: string;
    retryCount: number;
    lastAttemptAt: Date;
    nextRetryAt?: Date | null;
    lastErrorCode: string;
    lastErrorMessage: string;
  }): Promise<LiveLaneProjectionOutboxRow> {
    const sql = `
      update ${TABLES.liveLaneProjectionOutbox}
      set
        state = $2,
        retry_count = $3,
        last_attempt_at = $4,
        next_retry_at = $5,
        last_error_code = $6,
        last_error_message = $7,
        updated_at = now()
      where request_attempt_archive_id = $1
      returning *
    `;

    return this.expectOne(sql, [
      input.requestAttemptArchiveId,
      'needs_operator_correction',
      input.retryCount,
      input.lastAttemptAt,
      input.nextRetryAt ?? null,
      input.lastErrorCode,
      input.lastErrorMessage
    ]);
  }

  async requeueForProjection(input: {
    requestAttemptArchiveId: string;
    availableAt?: Date | null;
  }): Promise<LiveLaneProjectionOutboxRow> {
    const sql = `
      update ${TABLES.liveLaneProjectionOutbox}
      set
        state = $2,
        available_at = $3,
        next_retry_at = null,
        projected_at = null,
        last_error_code = null,
        last_error_message = null,
        updated_at = now()
      where request_attempt_archive_id = $1
      returning *
    `;

    return this.expectOne(sql, [
      input.requestAttemptArchiveId,
      'pending_projection',
      input.availableAt ?? new Date()
    ]);
  }

  async findByRequestAttemptArchiveId(requestAttemptArchiveId: string): Promise<LiveLaneProjectionOutboxRow | null> {
    const result = await this.db.query<LiveLaneProjectionOutboxRow>(`
      select *
      from ${TABLES.liveLaneProjectionOutbox}
      where request_attempt_archive_id = $1
      limit 1
    `, [requestAttemptArchiveId]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  private async expectOne(sql: string, params: SqlValue[]): Promise<LiveLaneProjectionOutboxRow> {
    const result = await this.db.query<LiveLaneProjectionOutboxRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one live lane outbox row');
    }
    return result.rows[0];
  }

  private async expectZeroOrOne(sql: string, params: SqlValue[]): Promise<LiveLaneProjectionOutboxRow | null> {
    const result = await this.db.query<LiveLaneProjectionOutboxRow>(sql, params);
    if (result.rowCount > 1) {
      throw new Error('expected at most one live lane outbox row');
    }
    return result.rows[0] ?? null;
  }
}
