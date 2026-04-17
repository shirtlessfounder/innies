import type { SqlClient, SqlValue } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';
import { LiveLaneProjectionOutboxRepository } from './liveLaneProjectionOutboxRepository.js';
import { decryptSecret, encryptSecret } from '../utils/crypto.js';

export type RequestLogWriteInput = {
  requestId: string;
  attemptNo: number;
  orgId: string;
  provider: string;
  model: string;
  proxiedPath?: string | null;
  requestContentType?: string | null;
  responseContentType?: string | null;
  promptPreview?: string | null;
  responsePreview?: string | null;
  fullPrompt?: string | null;
  fullResponse?: string | null;
};

type RequestLogRow = {
  id: string;
  request_id: string;
  attempt_no: number;
  org_id: string;
  provider: string;
  model: string;
  proxied_path: string | null;
  request_content_type: string | null;
  response_content_type: string | null;
  prompt_preview: string | null;
  response_preview: string | null;
  full_prompt_encrypted: Buffer | string | null;
  full_response_encrypted: Buffer | string | null;
  created_at: string | Date;
};

export type RequestLogRecord = {
  id: string;
  requestId: string;
  attemptNo: number;
  orgId: string;
  provider: string;
  model: string;
  proxiedPath: string | null;
  requestContentType: string | null;
  responseContentType: string | null;
  promptPreview: string | null;
  responsePreview: string | null;
  fullPrompt: string | null;
  fullResponse: string | null;
  createdAt: Date;
};

type LiveLaneProjectorRow = {
  request_attempt_archive_id: string;
  request_id: string;
  attempt_no: number;
  org_id: string;
  proxied_path: string | null;
  request_content_type: string | null;
  response_content_type: string | null;
  prompt_preview: string | null;
  response_preview: string | null;
  full_prompt_encrypted: Buffer | string | null;
  full_response_encrypted: Buffer | string | null;
  request_logged_at: string | Date;
  buyer_api_key_id: string | null;
  seller_key_id: string | null;
  provider: string;
  model: string;
  streaming: boolean;
  route_decision: Record<string, unknown> | string | null;
  upstream_status: number | null;
  error_code: string | null;
  latency_ms: number;
  ttfb_ms: number | null;
  routed_at: string | Date;
};

export type LiveLaneProjectorInput = {
  requestAttemptArchiveId: string;
  requestId: string;
  attemptNo: number;
  orgId: string;
  proxiedPath: string | null;
  requestContentType: string | null;
  responseContentType: string | null;
  promptPreview: string | null;
  responsePreview: string | null;
  fullPrompt: string | null;
  fullResponse: string | null;
  requestLoggedAt: Date;
  buyerApiKeyId: string | null;
  sellerKeyId: string | null;
  provider: string;
  model: string;
  streaming: boolean;
  routeDecision: Record<string, unknown> | null;
  upstreamStatus: number | null;
  errorCode: string | null;
  latencyMs: number;
  ttfbMs: number | null;
  routedAt: Date;
};

export type RequestLogQueryFilters = {
  orgId?: string;
  provider?: string;
  model?: string;
};

export type RequestLogQueryInput = {
  window: '24h' | '7d' | '1m' | 'all';
  limit: number;
  filters?: RequestLogQueryFilters;
  includeFull?: boolean;
};

export type PurgeResult = {
  deletedCount: number;
};

function mapRow(row: RequestLogRow, includeFull: boolean): RequestLogRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    attemptNo: Number(row.attempt_no),
    orgId: row.org_id,
    provider: row.provider,
    model: row.model,
    proxiedPath: row.proxied_path,
    requestContentType: row.request_content_type,
    responseContentType: row.response_content_type,
    promptPreview: row.prompt_preview,
    responsePreview: row.response_preview,
    fullPrompt: includeFull && row.full_prompt_encrypted ? decryptSecret(row.full_prompt_encrypted) : null,
    fullResponse: includeFull && row.full_response_encrypted ? decryptSecret(row.full_response_encrypted) : null,
    createdAt: new Date(row.created_at)
  };
}

function windowCondition(window: RequestLogQueryInput['window']): string {
  switch (window) {
    case '24h':
      return "created_at >= now() - interval '24 hours'";
    case '7d':
      return "created_at >= now() - interval '7 days'";
    case '1m':
      return "created_at >= now() - interval '30 days'";
    case 'all':
      return '1=1';
    default:
      return '1=1';
  }
}

export class RequestLogRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async insert(input: RequestLogWriteInput): Promise<string> {
    return this.db.transaction(async (tx) => {
      const sql = `
        insert into ${TABLES.requestLog} (
          id,
          request_id,
          attempt_no,
          org_id,
          provider,
          model,
          proxied_path,
          request_content_type,
          response_content_type,
          prompt_preview,
          response_preview,
          full_prompt_encrypted,
          full_response_encrypted,
          created_at
        ) values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()
        )
        on conflict (org_id, request_id, attempt_no)
        do update set
          provider = excluded.provider,
          model = excluded.model,
          proxied_path = coalesce(excluded.proxied_path, ${TABLES.requestLog}.proxied_path),
          request_content_type = coalesce(excluded.request_content_type, ${TABLES.requestLog}.request_content_type),
          response_content_type = coalesce(excluded.response_content_type, ${TABLES.requestLog}.response_content_type),
          prompt_preview = coalesce(excluded.prompt_preview, ${TABLES.requestLog}.prompt_preview),
          response_preview = coalesce(excluded.response_preview, ${TABLES.requestLog}.response_preview),
          full_prompt_encrypted = coalesce(excluded.full_prompt_encrypted, ${TABLES.requestLog}.full_prompt_encrypted),
          full_response_encrypted = coalesce(excluded.full_response_encrypted, ${TABLES.requestLog}.full_response_encrypted)
        returning id
      `;

      const params: SqlValue[] = [
        this.createId(),
        input.requestId,
        input.attemptNo,
        input.orgId,
        input.provider,
        input.model,
        input.proxiedPath ?? null,
        input.requestContentType ?? null,
        input.responseContentType ?? null,
        input.promptPreview ?? null,
        input.responsePreview ?? null,
        input.fullPrompt === null || input.fullPrompt === undefined ? null : encryptSecret(input.fullPrompt),
        input.fullResponse === null || input.fullResponse === undefined ? null : encryptSecret(input.fullResponse)
      ];

      const result = await tx.query<{ id: string }>(sql, params);
      if (result.rowCount !== 1 || !result.rows[0]?.id) {
        throw new Error('expected one request log row');
      }

      await new LiveLaneProjectionOutboxRepository(tx).enqueueJoinedAttemptByRequestKey({
        orgId: input.orgId,
        requestId: input.requestId,
        attemptNo: input.attemptNo
      });

      return result.rows[0].id;
    });
  }

  async query(input: RequestLogQueryInput): Promise<RequestLogRecord[]> {
    const params: SqlValue[] = [];
    const where = [windowCondition(input.window)];

    if (input.filters?.orgId) {
      params.push(input.filters.orgId);
      where.push(`org_id = $${params.length}`);
    }

    if (input.filters?.provider) {
      params.push(input.filters.provider);
      where.push(`provider = $${params.length}`);
    }

    if (input.filters?.model) {
      params.push(input.filters.model);
      where.push(`model = $${params.length}`);
    }

    params.push(Math.max(1, Math.min(200, input.limit)));

    const sql = `
      select
        id,
        request_id,
        attempt_no,
        org_id,
        provider,
        model,
        proxied_path,
        request_content_type,
        response_content_type,
        prompt_preview,
        response_preview,
        full_prompt_encrypted,
        full_response_encrypted,
        created_at
      from ${TABLES.requestLog}
      where ${where.join(' and ')}
      order by created_at desc
      limit $${params.length}
    `;

    const result = await this.db.query<RequestLogRow>(sql, params);
    return result.rows.map((row) => mapRow(row, input.includeFull === true));
  }

  async findByOrgRequestAttempt(input: {
    orgId: string;
    requestId: string;
    attemptNo: number;
  }): Promise<RequestLogRecord | null> {
    const sql = `
      select
        id,
        request_id,
        attempt_no,
        org_id,
        provider,
        model,
        proxied_path,
        request_content_type,
        response_content_type,
        prompt_preview,
        response_preview,
        full_prompt_encrypted,
        full_response_encrypted,
        created_at
      from ${TABLES.requestLog}
      where org_id = $1
        and request_id = $2
        and attempt_no = $3
      limit 1
    `;
    const result = await this.db.query<RequestLogRow>(sql, [
      input.orgId,
      input.requestId,
      input.attemptNo
    ]);
    const row = result.rows[0];
    return row ? mapRow(row, false) : null;
  }

  async findById(id: string, includeFull = false): Promise<RequestLogRecord | null> {
    const sql = `
      select
        id,
        request_id,
        attempt_no,
        org_id,
        provider,
        model,
        proxied_path,
        request_content_type,
        response_content_type,
        prompt_preview,
        response_preview,
        full_prompt_encrypted,
        full_response_encrypted,
        created_at
      from ${TABLES.requestLog}
      where id = $1
      limit 1
    `;

    const result = await this.db.query<RequestLogRow>(sql, [id]);
    if (result.rowCount !== 1) return null;
    return mapRow(result.rows[0], includeFull);
  }

  async findLiveLaneProjectorInput(requestAttemptArchiveId: string): Promise<LiveLaneProjectorInput | null> {
    const sql = `
      select
        rl.id as request_attempt_archive_id,
        rl.request_id,
        rl.attempt_no,
        rl.org_id,
        rl.proxied_path,
        rl.request_content_type,
        rl.response_content_type,
        rl.prompt_preview,
        rl.response_preview,
        rl.full_prompt_encrypted,
        rl.full_response_encrypted,
        rl.created_at as request_logged_at,
        re.api_key_id as buyer_api_key_id,
        re.seller_key_id,
        re.provider,
        re.model,
        re.streaming,
        re.route_decision,
        re.upstream_status,
        re.error_code,
        re.latency_ms,
        re.ttfb_ms,
        re.created_at as routed_at
      from ${TABLES.requestLog} rl
      join ${TABLES.routingEvents} re
        on re.org_id = rl.org_id
       and re.request_id = rl.request_id
       and re.attempt_no = rl.attempt_no
      where rl.id = $1
      limit 1
    `;

    const result = await this.db.query<LiveLaneProjectorRow>(sql, [requestAttemptArchiveId]);
    if (result.rowCount !== 1) {
      return null;
    }

    return mapLiveLaneProjectorRow(result.rows[0]);
  }

  async purgeOlderThan(days: number, now: Date = new Date()): Promise<PurgeResult> {
    const sql = `
      delete from ${TABLES.requestLog}
      where created_at < ($1::timestamptz - ($2::text || ' days')::interval)
    `;

    const result = await this.db.query(sql, [now, Math.max(1, Math.floor(days))]);
    return { deletedCount: result.rowCount };
  }
}

function mapLiveLaneProjectorRow(row: LiveLaneProjectorRow): LiveLaneProjectorInput {
  return {
    requestAttemptArchiveId: row.request_attempt_archive_id,
    requestId: row.request_id,
    attemptNo: Number(row.attempt_no),
    orgId: row.org_id,
    proxiedPath: row.proxied_path,
    requestContentType: row.request_content_type,
    responseContentType: row.response_content_type,
    promptPreview: row.prompt_preview,
    responsePreview: row.response_preview,
    fullPrompt: row.full_prompt_encrypted ? decryptSecret(row.full_prompt_encrypted) : null,
    fullResponse: row.full_response_encrypted ? decryptSecret(row.full_response_encrypted) : null,
    requestLoggedAt: new Date(row.request_logged_at),
    buyerApiKeyId: row.buyer_api_key_id,
    sellerKeyId: row.seller_key_id,
    provider: row.provider,
    model: row.model,
    streaming: row.streaming,
    routeDecision: normalizeJson<Record<string, unknown>>(row.route_decision),
    upstreamStatus: row.upstream_status,
    errorCode: row.error_code,
    latencyMs: Number(row.latency_ms),
    ttfbMs: row.ttfb_ms === null ? null : Number(row.ttfb_ms),
    routedAt: new Date(row.routed_at)
  };
}

function normalizeJson<T>(value: unknown): T | null {
  if (value == null) {
    return null;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  return value as T;
}
