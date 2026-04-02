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
  is_frozen?: boolean;
};

export type BuyerProviderPreferenceRecord = {
  id: string;
  org_id: string;
  scope: ApiKeyScope;
  preferred_provider: ProviderPreference | null;
  provider_preference_updated_at: string | null;
};

type ApiKeyIdRecord = Pick<ApiKeyRecord, 'id'>;
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

function isMissingPilotAdmissionFreezeTable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const details = error as { code?: string; message?: string };
  return details.code === '42P01'
    && details.message?.includes('in_pilot_admission_freezes') === true;
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

  async findIdByHash(keyHash: string): Promise<string | null> {
    const sql = `
      select id
      from in_api_keys
      where key_hash = $1
      limit 1
    `;
    const result = await this.db.query<ApiKeyIdRecord>(sql, [keyHash]);
    if (result.rowCount !== 1) return null;
    return result.rows[0]?.id ?? null;
  }

  async findActiveByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const runQuery = async (input: {
      includePreferredProvider: boolean;
      includeFreezeLookup: boolean;
    }): Promise<ApiKeyRecord | null> => {
      const sql = `
        select
          id,
          org_id,
          scope,
          name,
          is_active,
          expires_at,
          ${input.includePreferredProvider ? 'preferred_provider' : 'null::text as preferred_provider'},
          ${input.includeFreezeLookup ? `exists(
            select 1
            from in_pilot_admission_freezes paf
            where paf.resource_type = 'buyer_key'
              and paf.resource_id = in_api_keys.id
              and paf.released_at is null
          )` : 'false'} as is_frozen
        from in_api_keys
        where key_hash = $1
        limit 1
      `;
      const result = await this.db.query<ApiKeyRecord>(sql, [keyHash]);
      if (result.rowCount !== 1) return null;
      return result.rows[0];
    };

    try {
      const record = await runQuery({
        includePreferredProvider: true,
        includeFreezeLookup: true
      });
      return normalizeActiveApiKeyRecord(record ?? undefined);
    } catch (error) {
      if (isMissingBuyerProviderPreferenceColumn(error)) {
        try {
          const record = await runQuery({
            includePreferredProvider: false,
            includeFreezeLookup: true
          });
          return normalizeActiveApiKeyRecord(record ?? undefined);
        } catch (fallbackError) {
          if (!isMissingPilotAdmissionFreezeTable(fallbackError)) throw fallbackError;
          const record = await runQuery({
            includePreferredProvider: false,
            includeFreezeLookup: false
          });
          return normalizeActiveApiKeyRecord(record ?? undefined);
        }
      }

      if (!isMissingPilotAdmissionFreezeTable(error)) throw error;
      try {
        const record = await runQuery({
          includePreferredProvider: true,
          includeFreezeLookup: false
        });
        return normalizeActiveApiKeyRecord(record ?? undefined);
      } catch (fallbackError) {
        if (!isMissingBuyerProviderPreferenceColumn(fallbackError)) throw fallbackError;
        const record = await runQuery({
          includePreferredProvider: false,
          includeFreezeLookup: false
        });
        return normalizeActiveApiKeyRecord(record ?? undefined);
      }
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
