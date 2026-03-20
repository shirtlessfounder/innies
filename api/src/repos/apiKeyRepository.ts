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
  active_freeze_operation_kind?: 'cutover' | 'rollback' | null;
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
    preferred_provider: 'preferred_provider' in row ? row.preferred_provider ?? null : null,
    active_freeze_operation_kind: 'active_freeze_operation_kind' in row ? row.active_freeze_operation_kind ?? null : null
  };
}

function isMissingPilotCutoverFreezeTables(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const details = error as { code?: string; table?: string; message?: string };
  if (details.code !== '42P01') return false;
  return details.table === 'in_pilot_cutover_freezes'
    || details.table === 'in_pilot_cutover_freeze_credentials'
    || details.message?.includes('in_pilot_cutover_freezes') === true
    || details.message?.includes('in_pilot_cutover_freeze_credentials') === true;
}

export class ApiKeyRepository {
  constructor(private readonly db: SqlClient) {}

  async findActiveByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const sql = `
      select
        id,
        org_id,
        scope,
        name,
        is_active,
        expires_at,
        preferred_provider,
        (
          select operation_kind
          from in_pilot_cutover_freezes freeze
          where freeze.buyer_key_id = in_api_keys.id
            and freeze.released_at is null
          order by freeze.frozen_at desc
          limit 1
        ) as active_freeze_operation_kind
      from in_api_keys
      where key_hash = $1
      limit 1
    `;
    try {
      const result = await this.db.query<ApiKeyRecord>(sql, [keyHash]);
      if (result.rowCount !== 1) return null;
      return normalizeActiveApiKeyRecord(result.rows[0]);
    } catch (error) {
      if (!isMissingBuyerProviderPreferenceColumn(error) && !isMissingPilotCutoverFreezeTables(error)) throw error;

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

  async getById(id: string): Promise<ApiKeyRecord | null> {
    const sql = `
      select id, org_id, scope, name, is_active, expires_at, preferred_provider
      from in_api_keys
      where id = $1
      limit 1
    `;
    try {
      const result = await this.db.query<ApiKeyRecord>(sql, [id]);
      if (result.rowCount !== 1) return null;
      return normalizeActiveApiKeyRecord(result.rows[0]);
    } catch (error) {
      if (!isMissingBuyerProviderPreferenceColumn(error)) throw error;
      const fallback = await this.db.query<LegacyApiKeyRecord>(
        `
          select id, org_id, scope, name, is_active, expires_at
          from in_api_keys
          where id = $1
          limit 1
        `,
        [id]
      );
      if (fallback.rowCount !== 1) return null;
      return normalizeActiveApiKeyRecord(fallback.rows[0]);
    }
  }

  async reassignOrg(id: string, orgId: string): Promise<boolean> {
    const sql = `
      update in_api_keys
      set org_id = $2
      where id = $1
    `;
    const result = await this.db.query(sql, [id, orgId]);
    return result.rowCount === 1;
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
