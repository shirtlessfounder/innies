import type { SqlValue, TransactionContext } from './sqlClient.js';
import { TABLES } from './tableNames.js';
import type { LiveLaneIdentity } from '../services/liveLanes/liveLaneTypes.js';

export type LiveLaneUpsertInput = LiveLaneIdentity & {
  buyerApiKeyId?: string | null;
  latestRequestId?: string | null;
  latestAttemptNo?: number | null;
  latestRequestAttemptArchiveId?: string | null;
  latestProvider?: string | null;
  latestModel?: string | null;
  firstEventAt?: Date | null;
  lastEventAt?: Date | null;
};

export type LiveLaneRow = {
  lane_id: string;
  session_key: string;
  lane_source_kind: string;
  lane_source_id: string;
  buyer_api_key_id: string | null;
  latest_request_id: string | null;
  latest_attempt_no: number | null;
  latest_request_attempt_archive_id: string | null;
  latest_provider: string | null;
  latest_model: string | null;
  first_event_at: string | null;
  last_event_at: string | null;
  projection_version: number;
  created_at: string;
  updated_at: string;
};

type Queryable = Pick<TransactionContext, 'query'>;

export class LiveLaneRepository {
  constructor(private readonly db: Queryable) {}

  async upsertLane(input: LiveLaneUpsertInput): Promise<LiveLaneRow> {
    const sql = `
      insert into ${TABLES.liveLanes} (
        lane_id,
        session_key,
        lane_source_kind,
        lane_source_id,
        buyer_api_key_id,
        latest_request_id,
        latest_attempt_no,
        latest_request_attempt_archive_id,
        latest_provider,
        latest_model,
        first_event_at,
        last_event_at,
        projection_version,
        created_at,
        updated_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),now()
      )
      on conflict (lane_id)
      do update set
        session_key = excluded.session_key,
        lane_source_kind = excluded.lane_source_kind,
        lane_source_id = excluded.lane_source_id,
        buyer_api_key_id = coalesce(excluded.buyer_api_key_id, ${TABLES.liveLanes}.buyer_api_key_id),
        latest_request_id = case
          when ${TABLES.liveLanes}.last_event_at is null or excluded.last_event_at is null
            then coalesce(excluded.latest_request_id, ${TABLES.liveLanes}.latest_request_id)
          when excluded.last_event_at >= ${TABLES.liveLanes}.last_event_at
            then coalesce(excluded.latest_request_id, ${TABLES.liveLanes}.latest_request_id)
          else ${TABLES.liveLanes}.latest_request_id
        end,
        latest_attempt_no = case
          when ${TABLES.liveLanes}.last_event_at is null or excluded.last_event_at is null
            then coalesce(excluded.latest_attempt_no, ${TABLES.liveLanes}.latest_attempt_no)
          when excluded.last_event_at >= ${TABLES.liveLanes}.last_event_at
            then coalesce(excluded.latest_attempt_no, ${TABLES.liveLanes}.latest_attempt_no)
          else ${TABLES.liveLanes}.latest_attempt_no
        end,
        latest_request_attempt_archive_id = case
          when ${TABLES.liveLanes}.last_event_at is null or excluded.last_event_at is null
            then coalesce(excluded.latest_request_attempt_archive_id, ${TABLES.liveLanes}.latest_request_attempt_archive_id)
          when excluded.last_event_at >= ${TABLES.liveLanes}.last_event_at
            then coalesce(excluded.latest_request_attempt_archive_id, ${TABLES.liveLanes}.latest_request_attempt_archive_id)
          else ${TABLES.liveLanes}.latest_request_attempt_archive_id
        end,
        latest_provider = case
          when ${TABLES.liveLanes}.last_event_at is null or excluded.last_event_at is null
            then coalesce(excluded.latest_provider, ${TABLES.liveLanes}.latest_provider)
          when excluded.last_event_at >= ${TABLES.liveLanes}.last_event_at
            then coalesce(excluded.latest_provider, ${TABLES.liveLanes}.latest_provider)
          else ${TABLES.liveLanes}.latest_provider
        end,
        latest_model = case
          when ${TABLES.liveLanes}.last_event_at is null or excluded.last_event_at is null
            then coalesce(excluded.latest_model, ${TABLES.liveLanes}.latest_model)
          when excluded.last_event_at >= ${TABLES.liveLanes}.last_event_at
            then coalesce(excluded.latest_model, ${TABLES.liveLanes}.latest_model)
          else ${TABLES.liveLanes}.latest_model
        end,
        first_event_at = case
          when ${TABLES.liveLanes}.first_event_at is null then excluded.first_event_at
          when excluded.first_event_at is null then ${TABLES.liveLanes}.first_event_at
          else least(${TABLES.liveLanes}.first_event_at, excluded.first_event_at)
        end,
        last_event_at = case
          when ${TABLES.liveLanes}.last_event_at is null then excluded.last_event_at
          when excluded.last_event_at is null then ${TABLES.liveLanes}.last_event_at
          else greatest(${TABLES.liveLanes}.last_event_at, excluded.last_event_at)
        end,
        projection_version = excluded.projection_version,
        updated_at = now()
      returning *
    `;

    return this.expectOne(sql, [
      input.laneId,
      input.sessionKey,
      input.laneSourceKind,
      input.laneSourceId,
      input.buyerApiKeyId ?? null,
      input.latestRequestId ?? null,
      input.latestAttemptNo ?? null,
      input.latestRequestAttemptArchiveId ?? null,
      input.latestProvider ?? null,
      input.latestModel ?? null,
      input.firstEventAt ?? null,
      input.lastEventAt ?? null,
      input.projectionVersion
    ]);
  }

  async findByLaneId(laneId: string): Promise<LiveLaneRow | null> {
    const result = await this.db.query<LiveLaneRow>(`
      select *
      from ${TABLES.liveLanes}
      where lane_id = $1
      limit 1
    `, [laneId]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async findBySessionKey(sessionKey: string): Promise<LiveLaneRow | null> {
    const result = await this.db.query<LiveLaneRow>(`
      select *
      from ${TABLES.liveLanes}
      where session_key = $1
      limit 1
    `, [sessionKey]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  private async expectOne(sql: string, params: SqlValue[]): Promise<LiveLaneRow> {
    const result = await this.db.query<LiveLaneRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one live lane row');
    }
    return result.rows[0];
  }
}
