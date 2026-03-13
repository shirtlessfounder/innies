import { describe, expect, it } from 'vitest';
import type { SqlClient, SqlQueryResult, SqlValue, TransactionContext } from '../src/repos/sqlClient.js';
import { ApiKeyRepository } from '../src/repos/apiKeyRepository.js';

type QueryStep = SqlQueryResult | { error: unknown };

class SequenceSqlClient implements SqlClient {
  readonly queries: Array<{ sql: string; params?: SqlValue[] }> = [];

  constructor(private readonly steps: QueryStep[]) {}

  async query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<SqlQueryResult<T>> {
    this.queries.push({ sql, params });
    const next = this.steps.shift() ?? { rows: [], rowCount: 0 };
    if ('error' in next) throw next.error;
    return next as SqlQueryResult<T>;
  }

  async transaction<T>(run: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return run(this);
  }
}

describe('apiKeyRepository', () => {
  it('loads preferred provider when migration is present', async () => {
    const db = new SequenceSqlClient([{
      rows: [{
        id: 'key_1',
        org_id: '00000000-0000-0000-0000-000000000001',
        scope: 'buyer_proxy',
        name: 'shirtless',
        is_active: true,
        expires_at: null,
        preferred_provider: 'openai'
      }],
      rowCount: 1
    }]);
    const repo = new ApiKeyRepository(db);

    const record = await repo.findActiveByHash('hash_live');

    expect(record?.name).toBe('shirtless');
    expect(record?.preferred_provider).toBe('openai');
    expect(db.queries[0]?.sql).toContain('name');
    expect(db.queries[0]?.sql).toContain('preferred_provider');
  });

  it('falls back to the legacy auth query before migration 009 is applied', async () => {
    const db = new SequenceSqlClient([
      {
        error: {
          code: '42703',
          column: 'preferred_provider',
          message: 'column "preferred_provider" does not exist'
        }
      },
      {
        rows: [{
          id: 'key_1',
          org_id: '00000000-0000-0000-0000-000000000001',
          scope: 'buyer_proxy',
          name: 'shirtless',
          is_active: true,
          expires_at: null
        }],
        rowCount: 1
      }
    ]);
    const repo = new ApiKeyRepository(db);

    const record = await repo.findActiveByHash('hash_live');

    expect(record).toEqual({
      id: 'key_1',
      org_id: '00000000-0000-0000-0000-000000000001',
      scope: 'buyer_proxy',
      name: 'shirtless',
      is_active: true,
      expires_at: null,
      preferred_provider: null
    });
    expect(db.queries).toHaveLength(2);
    expect(db.queries[1]?.sql).toContain('name');
    expect(db.queries[0]?.sql).toContain('preferred_provider');
    expect(db.queries[1]?.sql).not.toContain('preferred_provider');
  });

  it('loads buyer provider preference via legacy read path before migration 009 is applied', async () => {
    const db = new SequenceSqlClient([
      {
        error: {
          code: '42703',
          column: 'provider_preference_updated_at',
          message: 'column "provider_preference_updated_at" does not exist'
        }
      },
      {
        rows: [{
          id: 'key_2',
          org_id: '00000000-0000-0000-0000-000000000002',
          scope: 'buyer_proxy'
        }],
        rowCount: 1
      }
    ]);
    const repo = new ApiKeyRepository(db);

    const record = await repo.getBuyerProviderPreference('key_2');

    expect(record).toEqual({
      id: 'key_2',
      org_id: '00000000-0000-0000-0000-000000000002',
      scope: 'buyer_proxy',
      preferred_provider: null,
      provider_preference_updated_at: null
    });
    expect(db.queries).toHaveLength(2);
    expect(db.queries[0]?.sql).toContain('provider_preference_updated_at');
    expect(db.queries[1]?.sql).not.toContain('preferred_provider');
  });
});
