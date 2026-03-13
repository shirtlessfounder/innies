import type { SqlClient, SqlValue } from './sqlClient.js';

export type ApiKeyScope = 'buyer_proxy' | 'admin';
export type ProviderPreference = 'anthropic' | 'openai';

export type ApiKeyRecord = {
  id: string;
  org_id: string | null;
  scope: ApiKeyScope;
  name?: string | null;
  is_active: boolean;
  expires_at: string | null;
  preferred_provider: ProviderPreference | null;
};

export type BuyerProviderPreferenceRecord = {
  id: string;
  org_id: string;
  scope: ApiKeyScope;
  preferred_provider: ProviderPreference | null;
  provider_preference_updated_at: string | null;
};

type LegacyApiKeyRecord = Omit<ApiKeyRecord, 'preferred_provider'>;
type LegacyBuyerProviderPreferenceRecord = Omit<BuyerProviderPreferenceRecord, 'preferred_provider' | 'provider_preference_updated_at'>;

export function isMissingBuyerProviderPreferenceColumn(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const details = error as { code?: string; column?: string; message?: string };
  if (details.code !== '42703') return false;
  return details.column === 'preferred_provider'
    || details.column === 'provider_preference_updated_at'
    || details.message?.includes('preferred_provider') === true
    || details.message?.includes('provider_preference_updated_at') === true;
}

function normalizeActiveApiKeyRecord(row: ApiKeyRecord | LegacyApiKeyRecord | undefined): ApiKeyRecord | null {
  if (!row) return null;
  if (!row.is_active) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;
  return {
    ...row,
    preferred_provider: 'preferred_provider' in row ? row.preferred_provider ?? null : null
  };
}

export class ApiKeyRepository {
  constructor(private readonly db: SqlClient) {}

  async findActiveByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const sql = `
      select id, org_id, scope, name, is_active, expires_at, preferred_provider
      from in_api_keys
      where key_hash = $1
      limit 1
    `;
    try {
      const result = await this.db.query<ApiKeyRecord>(sql, [keyHash]);
      if (result.rowCount !== 1) return null;
      return normalizeActiveApiKeyRecord(result.rows[0]);
    } catch (error) {
      if (!isMissingBuyerProviderPreferenceColumn(error)) throw error;

      // Roll app code before migration 009 without breaking API-key auth.
      const fallbackSql = `
        select id, org_id, scope, name, is_active, expires_at
        from in_api_keys
        where key_hash = $1
        limit 1
      `;
      const fallback = await this.db.query<LegacyApiKeyRecord>(fallbackSql, [keyHash]);
      if (fallback.rowCount !== 1) return null;
      return normalizeActiveApiKeyRecord(fallback.rows[0]);
    }
  }

  async touchLastUsed(id: string): Promise<void> {
    const sql = `update in_api_keys set last_used_at = now() where id = $1`;
    const params: SqlValue[] = [id];
    await this.db.query(sql, params);
  }

  async getBuyerProviderPreference(id: string): Promise<BuyerProviderPreferenceRecord | null> {
    const sql = `
      select
        id,
        org_id,
        scope,
        preferred_provider,
        provider_preference_updated_at
      from in_api_keys
      where id = $1
      limit 1
    `;
    try {
      const result = await this.db.query<BuyerProviderPreferenceRecord>(sql, [id]);
      if (result.rowCount !== 1) return null;
      return result.rows[0];
    } catch (error) {
      if (!isMissingBuyerProviderPreferenceColumn(error)) throw error;

      const fallbackSql = `
        select
          id,
          org_id,
          scope
        from in_api_keys
        where id = $1
        limit 1
      `;
      const fallback = await this.db.query<LegacyBuyerProviderPreferenceRecord>(fallbackSql, [id]);
      if (fallback.rowCount !== 1) return null;
      return {
        ...fallback.rows[0],
        preferred_provider: null,
        provider_preference_updated_at: null
      };
    }
  }

  async setBuyerProviderPreference(input: {
    id: string;
    preferredProvider: ProviderPreference | null;
  }): Promise<boolean> {
    const sql = `
      update in_api_keys
      set
        preferred_provider = $2,
        provider_preference_updated_at = now()
      where id = $1
        and scope = 'buyer_proxy'
    `;
    const params: SqlValue[] = [input.id, input.preferredProvider];
    const result = await this.db.query(sql, params);
    return result.rowCount === 1;
  }
}
