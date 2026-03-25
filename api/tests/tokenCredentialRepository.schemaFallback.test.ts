import { describe, expect, it } from 'vitest';
import type { SqlClient, SqlQueryResult, SqlValue, TransactionContext } from '../src/repos/sqlClient.js';
import { TokenCredentialRepository } from '../src/repos/tokenCredentialRepository.js';
import { encryptSecret } from '../src/utils/crypto.js';

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

describe('tokenCredentialRepository schema fallback', () => {
  it('creates token credentials without access-token fingerprint writes before migration 023', async () => {
    process.env.SELLER_SECRET_ENC_KEY_B64 = Buffer.alloc(32, 31).toString('base64');
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [{ present: false }], rowCount: 1 },
      { rows: [{ id: 'cred_legacy', rotation_version: 1 }], rowCount: 1 }
    ]);
    const repo = new TokenCredentialRepository(db);

    await repo.create({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'anthropic',
      authScheme: 'x_api_key',
      accessToken: 'legacy-access',
      refreshToken: 'legacy-refresh',
      debugLabel: 'legacy-main',
      expiresAt: new Date('2026-03-02T00:00:00Z')
    });

    expect(db.queries[2].sql).toContain('information_schema.columns');
    expect(db.queries[3].sql).not.toContain('access_token_sha256');
  });

  it('rotates token credentials without access-token fingerprint writes before migration 023', async () => {
    process.env.SELLER_SECRET_ENC_KEY_B64 = Buffer.alloc(32, 32).toString('base64');
    const db = new SequenceSqlClient([
      { rows: [{ id: 'latest_1', rotation_version: 2 }], rowCount: 1 },
      { rows: [{ id: 'old_1', status: 'active', debug_label: 'oauth-main-1' }], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [{ present: false }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 }
    ]);
    const repo = new TokenCredentialRepository(db);

    await repo.rotate({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'anthropic',
      authScheme: 'x_api_key',
      accessToken: 'rotated-access',
      refreshToken: 'rotated-refresh',
      expiresAt: new Date('2026-03-02T00:00:00Z')
    });

    expect(db.queries[3].sql).toContain('information_schema.columns');
    expect(db.queries[5].sql).not.toContain('access_token_sha256');
  });

  it('refreshes token credentials without access-token fingerprint writes before migration 023', async () => {
    process.env.SELLER_SECRET_ENC_KEY_B64 = Buffer.alloc(32, 33).toString('base64');
    const db = new SequenceSqlClient([
      { rows: [{ present: false }], rowCount: 1 },
      {
        rows: [{
          id: 'cred_legacy_refresh',
          org_id: '00000000-0000-0000-0000-000000000001',
          provider: 'openai',
          auth_scheme: 'bearer',
          encrypted_access_token: encryptSecret('refresh-access'),
          encrypted_refresh_token: encryptSecret('refresh-secret'),
          expires_at: '2026-03-02T00:00:00Z',
          status: 'active',
          rotation_version: 7,
          created_at: '2026-03-01T00:00:00Z',
          updated_at: '2026-03-01T00:00:00Z',
          revoked_at: null,
          monthly_contribution_limit_units: null,
          monthly_contribution_used_units: 0,
          monthly_window_start_at: '2026-03-01T00:00:00Z',
          five_hour_reserve_percent: 0,
          seven_day_reserve_percent: 0,
          debug_label: 'legacy-refresh',
          consecutive_failure_count: 0,
          consecutive_rate_limit_count: 0,
          last_failed_status: null,
          last_failed_at: null,
          last_rate_limited_at: null,
          maxed_at: null,
          rate_limited_until: null,
          next_probe_at: null,
          last_probe_at: '2026-03-01T00:01:00Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new TokenCredentialRepository(db);

    await repo.refreshInPlace({
      id: 'cred_legacy_refresh',
      accessToken: 'refresh-access',
      refreshToken: 'refresh-secret',
      expiresAt: new Date('2026-03-02T00:00:00Z')
    });

    expect(db.queries[0].sql).toContain('information_schema.columns');
    expect(db.queries[1].sql).not.toContain('access_token_sha256 = $6');
  });
});
