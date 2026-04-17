import type { SqlValue, TransactionContext } from './sqlClient.js';
import { TABLES } from './tableNames.js';
import { LIVE_LANE_PROJECTION_VERSION } from '../services/liveLanes/liveLaneTypes.js';

export type LiveLaneAttemptUpsertInput = {
  laneId: string;
  requestAttemptArchiveId: string;
  requestId: string;
  attemptNo: number;
  buyerApiKeyId?: string | null;
  provider?: string | null;
  model?: string | null;
  requestSource?: string | null;
  eventTime?: Date | null;
  projectionVersion?: number;
};

export type LiveLaneAttemptRow = {
  request_attempt_archive_id: string;
  lane_id: string;
  request_id: string;
  attempt_no: number;
  buyer_api_key_id: string | null;
  provider: string | null;
  model: string | null;
  request_source: string | null;
  event_time: string | null;
  projection_version: number;
  projected_at: string;
  created_at: string;
  updated_at: string;
};

type Queryable = Pick<TransactionContext, 'query'>;

export class LiveLaneAttemptRepository {
  constructor(private readonly db: Queryable) {}

  async upsertAttempt(input: LiveLaneAttemptUpsertInput): Promise<LiveLaneAttemptRow> {
    const sql = `
      insert into ${TABLES.liveLaneAttempts} (
        request_attempt_archive_id,
        lane_id,
        request_id,
        attempt_no,
        buyer_api_key_id,
        provider,
        model,
        request_source,
        event_time,
        projection_version,
        projected_at,
        created_at,
        updated_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now(),now()
      )
      on conflict (request_attempt_archive_id)
      do update set
        lane_id = excluded.lane_id,
        request_id = excluded.request_id,
        attempt_no = excluded.attempt_no,
        buyer_api_key_id = coalesce(excluded.buyer_api_key_id, ${TABLES.liveLaneAttempts}.buyer_api_key_id),
        provider = coalesce(excluded.provider, ${TABLES.liveLaneAttempts}.provider),
        model = coalesce(excluded.model, ${TABLES.liveLaneAttempts}.model),
        request_source = coalesce(excluded.request_source, ${TABLES.liveLaneAttempts}.request_source),
        event_time = coalesce(excluded.event_time, ${TABLES.liveLaneAttempts}.event_time),
        projection_version = excluded.projection_version,
        projected_at = now(),
        updated_at = now()
      returning *
    `;

    return this.expectOne(sql, [
      input.requestAttemptArchiveId,
      input.laneId,
      input.requestId,
      input.attemptNo,
      input.buyerApiKeyId ?? null,
      input.provider ?? null,
      input.model ?? null,
      input.requestSource ?? null,
      input.eventTime ?? null,
      input.projectionVersion ?? LIVE_LANE_PROJECTION_VERSION
    ]);
  }

  async findByRequestAttemptArchiveId(requestAttemptArchiveId: string): Promise<LiveLaneAttemptRow | null> {
    const result = await this.db.query<LiveLaneAttemptRow>(`
      select *
      from ${TABLES.liveLaneAttempts}
      where request_attempt_archive_id = $1
      limit 1
    `, [requestAttemptArchiveId]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  listByLaneId(laneId: string): Promise<LiveLaneAttemptRow[]> {
    return this.db.query<LiveLaneAttemptRow>(`
      select *
      from ${TABLES.liveLaneAttempts}
      where lane_id = $1
      order by coalesce(event_time, projected_at) asc, request_attempt_archive_id asc
    `, [laneId]).then((result) => result.rows);
  }

  private async expectOne(sql: string, params: SqlValue[]): Promise<LiveLaneAttemptRow> {
    const result = await this.db.query<LiveLaneAttemptRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one live lane attempt row');
    }
    return result.rows[0];
  }
}
