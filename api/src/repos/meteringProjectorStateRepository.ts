import type { SqlClient, SqlValue } from './sqlClient.js';
import { TABLES } from './tableNames.js';
import type { Projector, ProjectorState } from '../types/phase2Contracts.js';

export type MeteringProjectorStateRow = {
  metering_event_id: string;
  projector: Projector;
  state: ProjectorState;
  retry_count: number;
  last_attempt_at: string | null;
  next_retry_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  projected_at: string | null;
  created_at: string;
  updated_at: string;
};

export class MeteringProjectorStateRepository {
  constructor(private readonly db: SqlClient) {}

  async ensurePending(input: {
    meteringEventId: string;
    projector: Projector;
  }): Promise<MeteringProjectorStateRow> {
    const sql = `
      insert into ${TABLES.meteringProjectorStates} (
        metering_event_id,
        projector,
        state,
        retry_count,
        created_at,
        updated_at
      ) values (
        $1,$2,$3,0,now(),now()
      )
      on conflict (metering_event_id, projector)
      do update set
        updated_at = now()
      returning *
    `;
    const params: SqlValue[] = [
      input.meteringEventId,
      input.projector,
      'pending_projection'
    ];

    return this.expectOne(sql, params);
  }

  async markProjected(input: {
    meteringEventId: string;
    projector: Projector;
  }): Promise<MeteringProjectorStateRow> {
    const sql = `
      update ${TABLES.meteringProjectorStates}
      set
        state = $3,
        projected_at = now(),
        last_error_code = null,
        last_error_message = null,
        updated_at = now()
      where metering_event_id = $1
        and projector = $2
      returning *
    `;
    const params: SqlValue[] = [
      input.meteringEventId,
      input.projector,
      'projected'
    ];

    return this.expectOne(sql, params);
  }

  async markNeedsOperatorCorrection(input: {
    meteringEventId: string;
    projector: Projector;
    retryCount: number;
    lastAttemptAt: Date;
    nextRetryAt: Date | null;
    lastErrorCode: string;
    lastErrorMessage: string;
  }): Promise<MeteringProjectorStateRow> {
    const sql = `
      update ${TABLES.meteringProjectorStates}
      set
        state = $3,
        retry_count = $4,
        last_attempt_at = $5,
        next_retry_at = $6,
        last_error_code = $7,
        last_error_message = $8,
        updated_at = now()
      where metering_event_id = $1
        and projector = $2
      returning *
    `;
    const params: SqlValue[] = [
      input.meteringEventId,
      input.projector,
      'needs_operator_correction',
      input.retryCount,
      input.lastAttemptAt,
      input.nextRetryAt,
      input.lastErrorCode,
      input.lastErrorMessage
    ];

    return this.expectOne(sql, params);
  }

  listByMeteringEventId(meteringEventId: string): Promise<MeteringProjectorStateRow[]> {
    const sql = `
      select *
      from ${TABLES.meteringProjectorStates}
      where metering_event_id = $1
      order by projector asc
    `;
    return this.db.query<MeteringProjectorStateRow>(sql, [meteringEventId]).then((result) => result.rows);
  }

  listByProjectorAndState(input: {
    projector: Projector;
    state: ProjectorState;
  }): Promise<MeteringProjectorStateRow[]> {
    const sql = `
      select *
      from ${TABLES.meteringProjectorStates}
      where projector = $1
        and state = $2
      order by updated_at asc
    `;
    return this.db.query<MeteringProjectorStateRow>(sql, [input.projector, input.state]).then((result) => result.rows);
  }

  listDueForProjector(input: {
    projector: Projector;
    now: Date;
    limit: number;
  }): Promise<MeteringProjectorStateRow[]> {
    const sql = `
      select *
      from ${TABLES.meteringProjectorStates}
      where projector = $1
        and state = 'pending_projection'
        and (next_retry_at is null or next_retry_at <= $2)
      order by updated_at asc, metering_event_id asc
      limit $3
    `;
    return this.db.query<MeteringProjectorStateRow>(sql, [
      input.projector,
      input.now,
      Math.max(1, Math.min(200, Math.floor(input.limit)))
    ]).then((result) => result.rows);
  }

  async markPendingRetry(input: {
    meteringEventId: string;
    projector: Projector;
    retryCount: number;
    lastAttemptAt: Date;
    nextRetryAt: Date;
    lastErrorCode: string;
    lastErrorMessage: string;
  }): Promise<MeteringProjectorStateRow> {
    const sql = `
      update ${TABLES.meteringProjectorStates}
      set
        state = $3,
        retry_count = $4,
        last_attempt_at = $5,
        next_retry_at = $6,
        last_error_code = $7,
        last_error_message = $8,
        updated_at = now()
      where metering_event_id = $1
        and projector = $2
      returning *
    `;
    return this.expectOne(sql, [
      input.meteringEventId,
      input.projector,
      'pending_projection',
      input.retryCount,
      input.lastAttemptAt,
      input.nextRetryAt,
      input.lastErrorCode,
      input.lastErrorMessage
    ]);
  }

  async requeueForRetry(input: {
    meteringEventId: string;
    projector: Projector;
  }): Promise<MeteringProjectorStateRow> {
    const sql = `
      update ${TABLES.meteringProjectorStates}
      set
        state = $3,
        next_retry_at = null,
        last_error_code = null,
        last_error_message = null,
        updated_at = now()
      where metering_event_id = $1
        and projector = $2
      returning *
    `;
    return this.expectOne(sql, [
      input.meteringEventId,
      input.projector,
      'pending_projection'
    ]);
  }

  listOutstandingByProjector(input: {
    projector: Projector;
    limit?: number;
  }): Promise<MeteringProjectorStateRow[]> {
    const sql = `
      select *
      from ${TABLES.meteringProjectorStates}
      where projector = $1
        and state <> 'projected'
      order by updated_at asc, metering_event_id asc
      limit $2
    `;
    return this.db.query<MeteringProjectorStateRow>(sql, [
      input.projector,
      Math.max(1, Math.min(200, Math.floor(input.limit ?? 100)))
    ]).then((result) => result.rows);
  }

  private async expectOne(sql: string, params: SqlValue[]): Promise<MeteringProjectorStateRow> {
    const result = await this.db.query<MeteringProjectorStateRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one metering projector state row');
    }
    return result.rows[0];
  }
}
