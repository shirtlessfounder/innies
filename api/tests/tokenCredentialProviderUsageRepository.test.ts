import { describe, expect, it } from 'vitest';
import type { SqlClient, SqlQueryResult, SqlValue, TransactionContext } from '../src/repos/sqlClient.js';
import { TokenCredentialProviderUsageRepository } from '../src/repos/tokenCredentialProviderUsageRepository.js';

class SequenceSqlClient implements SqlClient {
  readonly queries: Array<{ sql: string; params?: SqlValue[] }> = [];

  constructor(private readonly results: Array<SqlQueryResult | Error>) {}

  async query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<SqlQueryResult<T>> {
    this.queries.push({ sql, params });
    const next = this.results.shift() ?? { rows: [], rowCount: 0 };
    if (next instanceof Error) {
      throw next;
    }
    return next as SqlQueryResult<T>;
  }

  async transaction<T>(run: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return run(this);
  }
}

function createMissingProviderUsageTableError(): Error {
  return Object.assign(new Error('relation "in_token_credential_provider_usage" does not exist'), {
    code: '42P01',
    table: 'in_token_credential_provider_usage'
  });
}

describe('tokenCredentialProviderUsageRepository', () => {
  it('upserts latest provider-usage snapshot for a token credential', async () => {
    const db = new SequenceSqlClient([{
      rows: [{
        token_credential_id: 'cred_1',
        org_id: '00000000-0000-0000-0000-000000000001',
        provider: 'anthropic',
        usage_source: 'anthropic_oauth_usage',
        five_hour_utilization_ratio: '0.76',
        five_hour_resets_at: '2026-03-04T05:00:00Z',
        seven_day_utilization_ratio: '0.41',
        seven_day_resets_at: '2026-03-09T00:00:00Z',
        raw_payload: { five_hour: { utilization: 0.76 } },
        fetched_at: '2026-03-04T00:00:00Z',
        created_at: '2026-03-04T00:00:00Z',
        updated_at: '2026-03-04T00:00:00Z'
      }],
      rowCount: 1
    }]);
    const repo = new TokenCredentialProviderUsageRepository(db);

    const snapshot = await repo.upsertSnapshot({
      tokenCredentialId: 'cred_1',
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'anthropic',
      fiveHourUtilizationRatio: 0.76,
      fiveHourResetsAt: new Date('2026-03-04T05:00:00Z'),
      sevenDayUtilizationRatio: 0.41,
      sevenDayResetsAt: new Date('2026-03-09T00:00:00Z'),
      rawPayload: { five_hour: { utilization: 0.76 } },
      fetchedAt: new Date('2026-03-04T00:00:00Z')
    });

    expect(snapshot.fiveHourUtilizationRatio).toBe(0.76);
    expect(snapshot.sevenDayUtilizationRatio).toBe(0.41);
    expect(db.queries[0].sql).toContain('insert into in_token_credential_provider_usage');
    expect(db.queries[0].sql).toContain('on conflict (token_credential_id)');
  });

  it('reads latest provider-usage snapshot by token credential id', async () => {
    const db = new SequenceSqlClient([{
      rows: [{
        token_credential_id: 'cred_1',
        org_id: '00000000-0000-0000-0000-000000000001',
        provider: 'anthropic',
        usage_source: 'anthropic_oauth_usage',
        five_hour_utilization_ratio: 0.33,
        five_hour_resets_at: null,
        seven_day_utilization_ratio: 0.12,
        seven_day_resets_at: null,
        raw_payload: '{"five_hour":{"utilization":0.33}}',
        fetched_at: '2026-03-04T00:00:00Z',
        created_at: '2026-03-04T00:00:00Z',
        updated_at: '2026-03-04T00:01:00Z'
      }],
      rowCount: 1
    }]);
    const repo = new TokenCredentialProviderUsageRepository(db);

    const snapshot = await repo.getByTokenCredentialId('cred_1');

    expect(snapshot?.tokenCredentialId).toBe('cred_1');
    expect(snapshot?.rawPayload).toEqual({ five_hour: { utilization: 0.33 } });
    expect(db.queries[0].sql).toContain('where token_credential_id = $1::uuid');
  });

  it('reads latest provider-usage snapshots by token credential ids in batch', async () => {
    const db = new SequenceSqlClient([{
      rows: [{
        token_credential_id: 'cred_1',
        org_id: '00000000-0000-0000-0000-000000000001',
        provider: 'anthropic',
        usage_source: 'anthropic_oauth_usage',
        five_hour_utilization_ratio: 0.5,
        five_hour_resets_at: null,
        seven_day_utilization_ratio: 0.2,
        seven_day_resets_at: null,
        raw_payload: '{}',
        fetched_at: '2026-03-04T00:00:00Z',
        created_at: '2026-03-04T00:00:00Z',
        updated_at: '2026-03-04T00:00:00Z'
      }],
      rowCount: 1
    }]);
    const repo = new TokenCredentialProviderUsageRepository(db);

    const snapshots = await repo.listByTokenCredentialIds(['cred_1', 'cred_2']);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.tokenCredentialId).toBe('cred_1');
    expect(db.queries[0].sql).toContain('where token_credential_id = any($1::uuid[])');
  });

  it('returns empty results when the provider-usage table is not available yet', async () => {
    const db = new SequenceSqlClient([createMissingProviderUsageTableError()]);
    const repo = new TokenCredentialProviderUsageRepository(db);

    const snapshots = await repo.listByTokenCredentialIds(['00000000-0000-0000-0000-000000000001']);

    expect(snapshots).toEqual([]);
  });

  it('returns null for single-record reads when the provider-usage table is not available yet', async () => {
    const db = new SequenceSqlClient([createMissingProviderUsageTableError()]);
    const repo = new TokenCredentialProviderUsageRepository(db);

    const snapshot = await repo.getByTokenCredentialId('00000000-0000-0000-0000-000000000001');

    expect(snapshot).toBeNull();
  });
});
