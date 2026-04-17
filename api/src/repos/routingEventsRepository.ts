import type { SqlClient, SqlValue } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';
import { LiveLaneProjectionOutboxRepository } from './liveLaneProjectionOutboxRepository.js';

export type RoutingEventInput = {
  requestId: string;
  attemptNo: number;
  orgId: string;
  apiKeyId?: string;
  sellerKeyId?: string;
  provider: string;
  model: string;
  streaming: boolean;
  routeDecision: Record<string, unknown>;
  upstreamStatus?: number;
  errorCode?: string;
  latencyMs: number;
  ttfbMs?: number | null;
};

export class RoutingEventsRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async insert(input: RoutingEventInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      const sql = `
        insert into ${TABLES.routingEvents} (
          id,
          request_id,
          attempt_no,
          org_id,
          api_key_id,
          seller_key_id,
          provider,
          model,
          streaming,
          route_decision,
          upstream_status,
          error_code,
          latency_ms,
          ttfb_ms,
          created_at
        ) values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now()
        )
        on conflict (org_id, request_id, attempt_no)
        do update set
          api_key_id = coalesce(excluded.api_key_id, ${TABLES.routingEvents}.api_key_id),
          seller_key_id = coalesce(excluded.seller_key_id, ${TABLES.routingEvents}.seller_key_id),
          provider = excluded.provider,
          model = excluded.model,
          streaming = excluded.streaming,
          route_decision = excluded.route_decision,
          upstream_status = coalesce(excluded.upstream_status, ${TABLES.routingEvents}.upstream_status),
          error_code = coalesce(excluded.error_code, ${TABLES.routingEvents}.error_code),
          latency_ms = greatest(${TABLES.routingEvents}.latency_ms, excluded.latency_ms),
          ttfb_ms = coalesce(excluded.ttfb_ms, ${TABLES.routingEvents}.ttfb_ms)
      `;

      const params: SqlValue[] = [
        this.createId(),
        input.requestId,
        input.attemptNo,
        input.orgId,
        input.apiKeyId ?? null,
        input.sellerKeyId ?? null,
        input.provider,
        input.model,
        input.streaming,
        JSON.stringify(input.routeDecision),
        input.upstreamStatus ?? null,
        input.errorCode ?? null,
        input.latencyMs,
        input.ttfbMs ?? null
      ];

      await tx.query(sql, params);
      await new LiveLaneProjectionOutboxRepository(tx).enqueueJoinedAttemptByRequestKey({
        orgId: input.orgId,
        requestId: input.requestId,
        attemptNo: input.attemptNo
      });
    });
  }
}
