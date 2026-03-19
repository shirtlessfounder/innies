import type { SqlClient, SqlQueryResult, SqlValue } from './sqlClient.js';
import { TABLES } from './tableNames.js';

export type ProviderUsageSource = 'anthropic_oauth_usage' | 'openai_wham_usage';
export type ProviderUsagePayload = Record<string, unknown> | unknown[];

type TokenCredentialProviderUsageRow = {
  token_credential_id: string;
  org_id: string;
  provider: string;
  usage_source: ProviderUsageSource;
  five_hour_utilization_ratio: number | string;
  five_hour_resets_at: string | Date | null;
  seven_day_utilization_ratio: number | string;
  seven_day_resets_at: string | Date | null;
  raw_payload: ProviderUsagePayload | string;
  fetched_at: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
};

export type TokenCredentialProviderUsageSnapshot = {
  tokenCredentialId: string;
  orgId: string;
  provider: string;
  usageSource: ProviderUsageSource;
  fiveHourUtilizationRatio: number;
  fiveHourResetsAt: Date | null;
  sevenDayUtilizationRatio: number;
  sevenDayResetsAt: Date | null;
  rawPayload: ProviderUsagePayload;
  fetchedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type UpsertTokenCredentialProviderUsageInput = {
  tokenCredentialId: string;
  orgId: string;
  provider: string;
  usageSource?: ProviderUsageSource;
  fiveHourUtilizationRatio: number;
  fiveHourResetsAt: Date | null;
  sevenDayUtilizationRatio: number;
  sevenDayResetsAt: Date | null;
  rawPayload: ProviderUsagePayload;
  fetchedAt: Date;
};

function isMissingTokenCredentialProviderUsageTable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const details = error as { code?: string; table?: string; message?: string };
  if (details.code !== '42P01') return false;
  return details.table === TABLES.tokenCredentialProviderUsage
    || details.message?.includes(TABLES.tokenCredentialProviderUsage) === true;
}

function parseRawPayload(value: ProviderUsagePayload | string): ProviderUsagePayload {
  if (typeof value === 'string') {
    return JSON.parse(value) as ProviderUsagePayload;
  }

  return value;
}

function mapRow(row: TokenCredentialProviderUsageRow): TokenCredentialProviderUsageSnapshot {
  return {
    tokenCredentialId: row.token_credential_id,
    orgId: row.org_id,
    provider: row.provider,
    usageSource: row.usage_source,
    fiveHourUtilizationRatio: Number(row.five_hour_utilization_ratio),
    fiveHourResetsAt: row.five_hour_resets_at ? new Date(row.five_hour_resets_at) : null,
    sevenDayUtilizationRatio: Number(row.seven_day_utilization_ratio),
    sevenDayResetsAt: row.seven_day_resets_at ? new Date(row.seven_day_resets_at) : null,
    rawPayload: parseRawPayload(row.raw_payload),
    fetchedAt: new Date(row.fetched_at),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

export class TokenCredentialProviderUsageRepository {
  constructor(private readonly db: SqlClient) {}

  async listByTokenCredentialIds(tokenCredentialIds: string[]): Promise<TokenCredentialProviderUsageSnapshot[]> {
    if (tokenCredentialIds.length === 0) {
      return [];
    }

    let result: SqlQueryResult<TokenCredentialProviderUsageRow>;
    try {
      result = await this.db.query<TokenCredentialProviderUsageRow>(
        `
          select
            token_credential_id,
            org_id,
            provider,
            usage_source,
            five_hour_utilization_ratio,
            five_hour_resets_at,
            seven_day_utilization_ratio,
            seven_day_resets_at,
            raw_payload,
            fetched_at,
            created_at,
            updated_at
          from ${TABLES.tokenCredentialProviderUsage}
          where token_credential_id = any($1::uuid[])
        `,
        [tokenCredentialIds]
      );
    } catch (error) {
      if (!isMissingTokenCredentialProviderUsageTable(error)) {
        throw error;
      }
      return [];
    }

    return result.rows.map(mapRow);
  }

  async getByTokenCredentialId(tokenCredentialId: string): Promise<TokenCredentialProviderUsageSnapshot | null> {
    let result: SqlQueryResult<TokenCredentialProviderUsageRow>;
    try {
      result = await this.db.query<TokenCredentialProviderUsageRow>(
        `
          select
            token_credential_id,
            org_id,
            provider,
            usage_source,
            five_hour_utilization_ratio,
            five_hour_resets_at,
            seven_day_utilization_ratio,
            seven_day_resets_at,
            raw_payload,
            fetched_at,
            created_at,
            updated_at
          from ${TABLES.tokenCredentialProviderUsage}
          where token_credential_id = $1::uuid
          limit 1
        `,
        [tokenCredentialId]
      );
    } catch (error) {
      if (!isMissingTokenCredentialProviderUsageTable(error)) {
        throw error;
      }
      return null;
    }

    if (result.rowCount !== 1) {
      return null;
    }

    return mapRow(result.rows[0]);
  }

  async upsertSnapshot(input: UpsertTokenCredentialProviderUsageInput): Promise<TokenCredentialProviderUsageSnapshot> {
    const params: SqlValue[] = [
      input.tokenCredentialId,
      input.orgId,
      input.provider,
      input.usageSource ?? 'anthropic_oauth_usage',
      input.fiveHourUtilizationRatio,
      input.fiveHourResetsAt,
      input.sevenDayUtilizationRatio,
      input.sevenDayResetsAt,
      input.rawPayload,
      input.fetchedAt
    ];

    const result = await this.db.query<TokenCredentialProviderUsageRow>(
      `
        insert into ${TABLES.tokenCredentialProviderUsage} (
          token_credential_id,
          org_id,
          provider,
          usage_source,
          five_hour_utilization_ratio,
          five_hour_resets_at,
          seven_day_utilization_ratio,
          seven_day_resets_at,
          raw_payload,
          fetched_at,
          created_at,
          updated_at
        ) values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, now(), now())
        on conflict (token_credential_id)
        do update set
          org_id = excluded.org_id,
          provider = excluded.provider,
          usage_source = excluded.usage_source,
          five_hour_utilization_ratio = excluded.five_hour_utilization_ratio,
          five_hour_resets_at = excluded.five_hour_resets_at,
          seven_day_utilization_ratio = excluded.seven_day_utilization_ratio,
          seven_day_resets_at = excluded.seven_day_resets_at,
          raw_payload = excluded.raw_payload,
          fetched_at = excluded.fetched_at,
          updated_at = now()
        returning
          token_credential_id,
          org_id,
          provider,
          usage_source,
          five_hour_utilization_ratio,
          five_hour_resets_at,
          seven_day_utilization_ratio,
          seven_day_resets_at,
          raw_payload,
          fetched_at,
          created_at,
          updated_at
      `,
      params
    );

    if (result.rowCount !== 1) {
      throw new Error('expected provider usage snapshot upsert');
    }

    return mapRow(result.rows[0]);
  }
}
