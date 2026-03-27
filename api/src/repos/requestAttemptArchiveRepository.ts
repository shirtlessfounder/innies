import type { SqlClient, SqlValue } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';

export type RequestAttemptRouteKind = 'seller_key' | 'token_credential';
export type RequestAttemptArchiveStatus = 'success' | 'failed' | 'partial';

export type RequestAttemptArchiveInput = {
  requestId: string;
  attemptNo: number;
  orgId: string;
  apiKeyId?: string | null;
  routeKind: RequestAttemptRouteKind;
  sellerKeyId?: string | null;
  tokenCredentialId?: string | null;
  provider: string;
  model: string;
  streaming: boolean;
  status: RequestAttemptArchiveStatus;
  upstreamStatus?: number | null;
  errorCode?: string | null;
  startedAt: Date;
  completedAt?: Date | null;
  openclawRunId?: string | null;
  openclawSessionId?: string | null;
  routingEventId?: string | null;
  usageLedgerId?: string | null;
  meteringEventId?: string | null;
};

export type RequestAttemptArchiveRow = {
  id: string;
  request_id: string;
  attempt_no: number;
  org_id: string;
  api_key_id: string | null;
  route_kind: RequestAttemptRouteKind;
  seller_key_id: string | null;
  token_credential_id: string | null;
  provider: string;
  model: string;
  streaming: boolean;
  status: RequestAttemptArchiveStatus;
  upstream_status: number | null;
  error_code: string | null;
  started_at: string | Date;
  completed_at: string | Date | null;
  openclaw_run_id: string | null;
  openclaw_session_id: string | null;
  routing_event_id: string | null;
  usage_ledger_id: string | null;
  metering_event_id: string | null;
  created_at: string | Date;
};

export class RequestAttemptArchiveRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async upsertArchive(input: RequestAttemptArchiveInput): Promise<RequestAttemptArchiveRow> {
    const sql = `
      insert into ${TABLES.requestAttemptArchives} (
        id,
        request_id,
        attempt_no,
        org_id,
        api_key_id,
        route_kind,
        seller_key_id,
        token_credential_id,
        provider,
        model,
        streaming,
        status,
        upstream_status,
        error_code,
        started_at,
        completed_at,
        openclaw_run_id,
        openclaw_session_id,
        routing_event_id,
        usage_ledger_id,
        metering_event_id
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
      )
      on conflict (org_id, request_id, attempt_no)
      do update set
        api_key_id = coalesce(excluded.api_key_id, ${TABLES.requestAttemptArchives}.api_key_id),
        route_kind = excluded.route_kind,
        seller_key_id = coalesce(excluded.seller_key_id, ${TABLES.requestAttemptArchives}.seller_key_id),
        token_credential_id = coalesce(excluded.token_credential_id, ${TABLES.requestAttemptArchives}.token_credential_id),
        provider = excluded.provider,
        model = excluded.model,
        streaming = excluded.streaming,
        status = excluded.status,
        upstream_status = coalesce(excluded.upstream_status, ${TABLES.requestAttemptArchives}.upstream_status),
        error_code = coalesce(excluded.error_code, ${TABLES.requestAttemptArchives}.error_code),
        started_at = least(${TABLES.requestAttemptArchives}.started_at, excluded.started_at),
        completed_at = coalesce(excluded.completed_at, ${TABLES.requestAttemptArchives}.completed_at),
        openclaw_run_id = coalesce(excluded.openclaw_run_id, ${TABLES.requestAttemptArchives}.openclaw_run_id),
        openclaw_session_id = coalesce(excluded.openclaw_session_id, ${TABLES.requestAttemptArchives}.openclaw_session_id),
        routing_event_id = coalesce(excluded.routing_event_id, ${TABLES.requestAttemptArchives}.routing_event_id),
        usage_ledger_id = coalesce(excluded.usage_ledger_id, ${TABLES.requestAttemptArchives}.usage_ledger_id),
        metering_event_id = coalesce(excluded.metering_event_id, ${TABLES.requestAttemptArchives}.metering_event_id)
      returning *
    `;

    const params: SqlValue[] = [
      this.createId(),
      input.requestId,
      input.attemptNo,
      input.orgId,
      input.apiKeyId ?? null,
      input.routeKind,
      input.sellerKeyId ?? null,
      input.tokenCredentialId ?? null,
      input.provider,
      input.model,
      input.streaming,
      input.status,
      input.upstreamStatus ?? null,
      input.errorCode ?? null,
      input.startedAt,
      input.completedAt ?? null,
      input.openclawRunId ?? null,
      input.openclawSessionId ?? null,
      input.routingEventId ?? null,
      input.usageLedgerId ?? null,
      input.meteringEventId ?? null
    ];

    const result = await this.db.query<RequestAttemptArchiveRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one request attempt archive row');
    }
    return result.rows[0];
  }

  async findByOrgRequestAttempt(input: {
    orgId: string;
    requestId: string;
    attemptNo: number;
  }): Promise<RequestAttemptArchiveRow | null> {
    const sql = `
      select *
      from ${TABLES.requestAttemptArchives}
      where org_id = $1
        and request_id = $2
        and attempt_no = $3
      limit 1
    `;
    const result = await this.db.query<RequestAttemptArchiveRow>(sql, [
      input.orgId,
      input.requestId,
      input.attemptNo
    ]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }
}
