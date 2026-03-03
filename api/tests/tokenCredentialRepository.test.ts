import { describe, expect, it } from 'vitest';
import type { SqlClient, SqlQueryResult, SqlValue, TransactionContext } from '../src/repos/sqlClient.js';
import { TokenCredentialRepository } from '../src/repos/tokenCredentialRepository.js';
import { encryptSecret } from '../src/utils/crypto.js';

class SequenceSqlClient implements SqlClient {
  readonly queries: Array<{ sql: string; params?: SqlValue[] }> = [];

  constructor(private readonly results: SqlQueryResult[]) {}

  async query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<SqlQueryResult<T>> {
    this.queries.push({ sql, params });
    const next = this.results.shift() ?? { rows: [], rowCount: 0 };
    return next as SqlQueryResult<T>;
  }

  async transaction<T>(run: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return run(this);
  }
}

describe('tokenCredentialRepository', () => {
  it('creates encrypted token credential row', async () => {
    process.env.SELLER_SECRET_ENC_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      { rows: [{ id: 'cred_1', rotation_version: 1 }], rowCount: 1 }
    ]);
    const repo = new TokenCredentialRepository(db);

    const saved = await repo.create({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'anthropic',
      authScheme: 'x_api_key',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: new Date('2026-03-02T00:00:00Z')
    });

    expect(saved.id).toBe('cred_1');
    expect(saved.rotationVersion).toBe(1);
    expect(db.queries[1].sql).toContain('insert into in_token_credentials');
    expect(Buffer.isBuffer(db.queries[1].params?.[4])).toBe(true);
    expect(Buffer.isBuffer(db.queries[1].params?.[5])).toBe(true);
    expect(String(db.queries[1].params?.[4])).not.toContain('access-secret');
  });

  it('selects and decrypts active credential', async () => {
    process.env.SELLER_SECRET_ENC_KEY_B64 = Buffer.alloc(32, 9).toString('base64');
    const access = encryptSecret('access-live');
    const refresh = encryptSecret('refresh-live');
    const db = new SequenceSqlClient([{
      rows: [{
        id: 'cred_1',
        org_id: '00000000-0000-0000-0000-000000000001',
        provider: 'anthropic',
        auth_scheme: 'x_api_key',
        encrypted_access_token: access,
        encrypted_refresh_token: refresh,
        expires_at: '2026-03-02T00:00:00Z',
        status: 'active',
        rotation_version: 1,
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-01T00:00:00Z',
        revoked_at: null,
        monthly_contribution_limit_units: null,
        monthly_contribution_used_units: 0,
        monthly_window_start_at: '2026-03-01T00:00:00Z'
      }],
      rowCount: 1
    }]);
    const repo = new TokenCredentialRepository(db);

    const [found] = await repo.listActiveForRouting('00000000-0000-0000-0000-000000000001', 'anthropic');
    expect(found?.accessToken).toBe('access-live');
    expect(found?.refreshToken).toBe('refresh-live');
    expect(db.queries[0].sql).toContain("and expires_at > now()");
  });

  it('rotates active credential with deterministic status updates', async () => {
    process.env.SELLER_SECRET_ENC_KEY_B64 = Buffer.alloc(32, 11).toString('base64');
    const db = new SequenceSqlClient([
      { rows: [{ id: 'latest_1', rotation_version: 2 }], rowCount: 1 },
      { rows: [{ id: 'old_1' }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 }
    ]);
    const repo = new TokenCredentialRepository(db);

    const rotated = await repo.rotate({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'anthropic',
      authScheme: 'x_api_key',
      accessToken: 'next-token',
      refreshToken: 'next-refresh',
      expiresAt: new Date('2026-03-02T00:00:00Z')
    });

    expect(rotated.rotationVersion).toBe(3);
    expect(rotated.previousId).toBe('old_1');
    expect(db.queries[2].sql).toContain("set status = 'rotating'");
    expect(db.queries[4].sql).toContain("set status = 'revoked'");
  });

  it('increments monthly contribution usage when under cap', async () => {
    const db = new SequenceSqlClient([{ rows: [], rowCount: 1 }]);
    const repo = new TokenCredentialRepository(db);

    const ok = await repo.addMonthlyContributionUsage('cred_1', 120);
    expect(ok).toBe(true);
    expect(db.queries[0].sql).toContain('monthly_contribution_used_units');
  });
});
