import type { SqlClient, SqlValue } from './sqlClient.js';
import { newId } from '../utils/ids.js';

export type IdempotencyRecord = {
  id: string;
  scope: string;
  tenant_scope: string;
  idempotency_key: string;
  request_hash: string;
  response_code: number;
  response_body: Record<string, unknown> | null;
  response_digest: string | null;
  response_ref: string | null;
  expires_at: string;
};

export type IdempotencyStoreInput = {
  scope: string;
  tenantScope: string;
  idempotencyKey: string;
  requestHash: string;
  responseCode: number;
  responseBody: Record<string, unknown> | null;
  responseDigest?: string | null;
  responseRef?: string | null;
  expiresAt: Date;
};

export type IdempotencyPurgeResult = {
  deletedCount: number;
};

export class IdempotencyRepository {
  constructor(private readonly db: SqlClient) {}

  async find(scope: string, tenantScope: string, idempotencyKey: string): Promise<IdempotencyRecord | null> {
    const sql = `
      select
        id,
        scope,
        tenant_scope,
        idempotency_key,
        request_hash,
        response_code,
        response_body,
        response_digest,
        response_ref,
        expires_at
      from in_idempotency_keys
      where scope = $1 and tenant_scope = $2 and idempotency_key = $3
      limit 1
    `;
    const result = await this.db.query<IdempotencyRecord>(sql, [scope, tenantScope, idempotencyKey]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async store(input: IdempotencyStoreInput): Promise<IdempotencyRecord> {
    const sql = `
      insert into in_idempotency_keys (
        id,
        scope,
        tenant_scope,
        idempotency_key,
        request_hash,
        response_code,
        response_body,
        response_digest,
        response_ref,
        created_at,
        expires_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10)
      returning
        id,
        scope,
        tenant_scope,
        idempotency_key,
        request_hash,
        response_code,
        response_body,
        response_digest,
        response_ref,
        expires_at
    `;

    const params: SqlValue[] = [
      newId(),
      input.scope,
      input.tenantScope,
      input.idempotencyKey,
      input.requestHash,
      input.responseCode,
      input.responseBody,
      input.responseDigest ?? null,
      input.responseRef ?? null,
      input.expiresAt
    ];

    const result = await this.db.query<IdempotencyRecord>(sql, params);
    if (result.rowCount !== 1) throw new Error('expected one idempotency row');
    return result.rows[0];
  }

  async purgeExpired(before: Date): Promise<IdempotencyPurgeResult> {
    const sql = `delete from in_idempotency_keys where expires_at <= $1`;
    const params: SqlValue[] = [before];
    const result = await this.db.query(sql, params);
    return { deletedCount: result.rowCount };
  }
}
