import type { SqlClient, SqlValue } from './sqlClient.js';

export type ApiKeyScope = 'buyer_proxy' | 'admin';

export type ApiKeyRecord = {
  id: string;
  org_id: string | null;
  scope: ApiKeyScope;
  is_active: boolean;
  expires_at: string | null;
};

export class ApiKeyRepository {
  constructor(private readonly db: SqlClient) {}

  async findActiveByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const sql = `
      select id, org_id, scope, is_active, expires_at
      from in_api_keys
      where key_hash = $1
      limit 1
    `;
    const result = await this.db.query<ApiKeyRecord>(sql, [keyHash]);
    if (result.rowCount !== 1) return null;

    const row = result.rows[0];
    if (!row.is_active) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;
    return row;
  }

  async touchLastUsed(id: string): Promise<void> {
    const sql = `update in_api_keys set last_used_at = now() where id = $1`;
    const params: SqlValue[] = [id];
    await this.db.query(sql, params);
  }
}
