import type { SqlValue, TransactionContext } from './sqlClient.js';
import { TABLES } from './tableNames.js';
import { LIVE_LANE_PROJECTION_VERSION } from '../services/liveLanes/liveLaneTypes.js';

export type LiveLaneEventUpsertInput = {
  laneEventId: string;
  laneId: string;
  requestAttemptArchiveId: string;
  requestId: string;
  attemptNo: number;
  side: string;
  ordinal?: number | null;
  eventKind: string;
  eventTime: Date;
  role?: string | null;
  provider?: string | null;
  model?: string | null;
  status?: string | null;
  renderText?: string | null;
  renderSummary?: string | null;
  renderMeta?: Record<string, unknown> | null;
  projectionVersion?: number;
};

export type LiveLaneEventRow = {
  lane_event_id: string;
  lane_id: string;
  request_attempt_archive_id: string;
  request_id: string;
  attempt_no: number;
  side: string;
  ordinal: number | null;
  event_kind: string;
  event_time: string;
  role: string | null;
  provider: string | null;
  model: string | null;
  status: string | null;
  render_text: string | null;
  render_summary: string | null;
  render_meta: Record<string, unknown>;
  projection_version: number;
  created_at: string;
  updated_at: string;
};

type Queryable = Pick<TransactionContext, 'query'>;

export class LiveLaneEventRepository {
  constructor(private readonly db: Queryable) {}

  async upsertEvent(input: LiveLaneEventUpsertInput): Promise<LiveLaneEventRow> {
    const sql = `
      insert into ${TABLES.liveLaneEvents} (
        lane_event_id,
        lane_id,
        request_attempt_archive_id,
        request_id,
        attempt_no,
        side,
        ordinal,
        event_kind,
        event_time,
        role,
        provider,
        model,
        status,
        render_text,
        render_summary,
        render_meta,
        projection_version,
        created_at,
        updated_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),now()
      )
      on conflict (lane_event_id)
      do update set
        lane_id = excluded.lane_id,
        request_attempt_archive_id = excluded.request_attempt_archive_id,
        request_id = excluded.request_id,
        attempt_no = excluded.attempt_no,
        side = excluded.side,
        ordinal = excluded.ordinal,
        event_kind = excluded.event_kind,
        event_time = excluded.event_time,
        role = excluded.role,
        provider = excluded.provider,
        model = excluded.model,
        status = excluded.status,
        render_text = excluded.render_text,
        render_summary = excluded.render_summary,
        render_meta = excluded.render_meta,
        projection_version = excluded.projection_version,
        updated_at = now()
      returning *
    `;

    return this.expectOne(sql, [
      input.laneEventId,
      input.laneId,
      input.requestAttemptArchiveId,
      input.requestId,
      input.attemptNo,
      input.side,
      input.ordinal ?? null,
      input.eventKind,
      input.eventTime,
      input.role ?? null,
      input.provider ?? null,
      input.model ?? null,
      input.status ?? null,
      input.renderText ?? null,
      input.renderSummary ?? null,
      JSON.stringify(input.renderMeta ?? {}),
      input.projectionVersion ?? LIVE_LANE_PROJECTION_VERSION
    ]);
  }

  async findByLaneEventId(laneEventId: string): Promise<LiveLaneEventRow | null> {
    const result = await this.db.query<LiveLaneEventRow>(`
      select *
      from ${TABLES.liveLaneEvents}
      where lane_event_id = $1
      limit 1
    `, [laneEventId]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  listByLaneId(input: {
    laneId: string;
    limit?: number;
  }): Promise<LiveLaneEventRow[]> {
    return this.db.query<LiveLaneEventRow>(`
      select *
      from ${TABLES.liveLaneEvents}
      where lane_id = $1
      order by
        event_time asc,
        case side
          when 'request' then 1
          when 'response' then 2
          when 'system' then 3
          when 'attempt' then 4
          else 5
        end asc,
        ordinal asc nulls last,
        lane_event_id asc
      limit $2
    `, [
      input.laneId,
      Math.max(1, Math.min(500, Math.floor(input.limit ?? 200)))
    ]).then((result) => result.rows);
  }

  private async expectOne(sql: string, params: SqlValue[]): Promise<LiveLaneEventRow> {
    const result = await this.db.query<LiveLaneEventRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one live lane event row');
    }
    return result.rows[0];
  }
}
