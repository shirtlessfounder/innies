import type { SqlClient, SqlValue } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';
import { assertIdempotentReplayMatches } from './idempotentReplay.js';

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
      do nothing
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
    if (result.rowCount === 1) {
      return result.rows[0];
    }

    const existing = await this.findByOrgRequestAttempt({
      orgId: input.orgId,
      requestId: input.requestId,
      attemptNo: input.attemptNo
    });
    if (!existing) {
      throw new Error('expected one request attempt archive row');
    }

    assertRequestAttemptArchiveReplayMatches(input, existing);
    return existing;
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

  async findByRequestAttempt(requestId: string, attemptNo: number): Promise<RequestAttemptArchiveRow | null> {
    const sql = `
      select *
      from ${TABLES.requestAttemptArchives}
      where request_id = $1
        and attempt_no = $2
      order by created_at desc
      limit 1
    `;
    const result = await this.db.query<RequestAttemptArchiveRow>(sql, [requestId, attemptNo]);
    return result.rows[0] ?? null;
  }

  listByIds(ids: string[]): Promise<RequestAttemptArchiveRow[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }

    const sql = `
      select *
      from ${TABLES.requestAttemptArchives}
      where id::text = any($1::text[])
      order by array_position($1::text[], id::text)
    `;
    return this.db.query<RequestAttemptArchiveRow>(sql, [ids]).then((result) => result.rows);
  }
}

function assertRequestAttemptArchiveReplayMatches(
  input: RequestAttemptArchiveInput,
  row: RequestAttemptArchiveRow
): void {
  assertIdempotentReplayMatches('request attempt archive', [
    { field: 'requestId', expected: input.requestId, actual: row.request_id },
    { field: 'attemptNo', expected: input.attemptNo, actual: row.attempt_no },
    { field: 'orgId', expected: input.orgId, actual: row.org_id },
    { field: 'apiKeyId', expected: input.apiKeyId ?? null, actual: row.api_key_id },
    { field: 'routeKind', expected: input.routeKind, actual: row.route_kind },
    { field: 'sellerKeyId', expected: input.sellerKeyId ?? null, actual: row.seller_key_id },
    { field: 'tokenCredentialId', expected: input.tokenCredentialId ?? null, actual: row.token_credential_id },
    { field: 'provider', expected: input.provider, actual: row.provider },
    { field: 'model', expected: input.model, actual: row.model },
    { field: 'streaming', expected: input.streaming, actual: row.streaming },
    { field: 'status', expected: input.status, actual: row.status },
    { field: 'upstreamStatus', expected: input.upstreamStatus ?? null, actual: row.upstream_status },
    { field: 'errorCode', expected: input.errorCode ?? null, actual: row.error_code },
    { field: 'startedAt', expected: normalizeTimestamp(input.startedAt), actual: normalizeTimestamp(row.started_at) },
    { field: 'openclawRunId', expected: input.openclawRunId ?? null, actual: row.openclaw_run_id },
    { field: 'openclawSessionId', expected: input.openclawSessionId ?? null, actual: row.openclaw_session_id },
    { field: 'routingEventId', expected: input.routingEventId ?? null, actual: row.routing_event_id },
    { field: 'usageLedgerId', expected: input.usageLedgerId ?? null, actual: row.usage_ledger_id },
    { field: 'meteringEventId', expected: input.meteringEventId ?? null, actual: row.metering_event_id }
  ]);
}

function normalizeTimestamp(value: string | Date | null): string | null {
  if (value == null) {
    return null;
  }
  return new Date(value).toISOString();
}
