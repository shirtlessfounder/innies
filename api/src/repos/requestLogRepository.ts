import type { SqlClient, SqlValue } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';
import { decryptSecret, encryptSecret } from '../utils/crypto.js';

export type RequestLogWriteInput = {
  requestId: string;
  attemptNo: number;
  orgId: string;
  provider: string;
  model: string;
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
  promptPreview: string | null;
  responsePreview: string | null;
  fullPrompt: string | null;
  fullResponse: string | null;
  createdAt: Date;
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

  async insert(input: RequestLogWriteInput): Promise<void> {
    const sql = `
      insert into ${TABLES.requestLog} (
        id,
        request_id,
        attempt_no,
        org_id,
        provider,
        model,
        prompt_preview,
        response_preview,
        full_prompt_encrypted,
        full_response_encrypted,
        created_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()
      )
      on conflict (org_id, request_id, attempt_no)
      do update set
        provider = excluded.provider,
        model = excluded.model,
        prompt_preview = excluded.prompt_preview,
        response_preview = excluded.response_preview,
        full_prompt_encrypted = coalesce(excluded.full_prompt_encrypted, ${TABLES.requestLog}.full_prompt_encrypted),
        full_response_encrypted = coalesce(excluded.full_response_encrypted, ${TABLES.requestLog}.full_response_encrypted)
    `;

    const params: SqlValue[] = [
      this.createId(),
      input.requestId,
      input.attemptNo,
      input.orgId,
      input.provider,
      input.model,
      input.promptPreview ?? null,
      input.responsePreview ?? null,
      input.fullPrompt ? encryptSecret(input.fullPrompt) : null,
      input.fullResponse ? encryptSecret(input.fullResponse) : null
    ];

    await this.db.query(sql, params);
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

  async purgeOlderThan(days: number, now: Date = new Date()): Promise<PurgeResult> {
    const sql = `
      delete from ${TABLES.requestLog}
      where created_at < ($1::timestamptz - ($2::text || ' days')::interval)
    `;

    const result = await this.db.query(sql, [now, Math.max(1, Math.floor(days))]);
    return { deletedCount: result.rowCount };
  }
}
