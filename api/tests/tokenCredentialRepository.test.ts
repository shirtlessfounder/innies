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
    expect(db.queries[0].sql).toContain('rate_limited_until is null or rate_limited_until <= now()');
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

  it('records failure and marks credential maxed when threshold is reached', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{
          previous_status: 'active',
          org_id: '00000000-0000-0000-0000-000000000001',
          provider: 'anthropic',
          status: 'maxed',
          consecutive_failures: 10,
          monthly_contribution_used_units: 4321
        }],
        rowCount: 1
      },
      { rows: [], rowCount: 1 }
    ]);
    const repo = new TokenCredentialRepository(db);

    const result = await repo.recordFailureAndMaybeMax({
      id: 'cred_1',
      statusCode: 401,
      threshold: 10,
      nextProbeAt: new Date('2026-03-04T00:00:00Z'),
      reason: 'upstream_401_consecutive_failure',
      requestId: 'req_123',
      attemptNo: 2
    });

    expect(result).toEqual({ status: 'maxed', consecutiveFailures: 10, newlyMaxed: true });
    expect(db.queries[0].sql).toContain("then 'maxed'");
    expect(db.queries[1].sql).toContain('insert into in_token_credential_events');
    expect(db.queries[1].sql).toContain("'maxed'");
    expect(db.queries[1].params?.[6]).toMatchObject({
      requestId: 'req_123',
      attemptNo: 2,
      statusCode: 401,
      threshold: 10,
      consecutiveFailures: 10,
      monthlyContributionUsedUnits: 4321
    });
  });

  it('records repeated 429s into the short rate-limit cooldown without maxing', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{
          previous_status: 'active',
          org_id: '00000000-0000-0000-0000-000000000001',
          provider: 'anthropic',
          status: 'active',
          consecutive_rate_limits: 5,
          rate_limited_until: '2026-03-04T00:05:00Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new TokenCredentialRepository(db);

    const result = await repo.recordRateLimitAndMaybeMax({
      id: 'cred_1',
      statusCode: 429,
      cooldownThreshold: 5,
      cooldownUntil: new Date('2026-03-04T00:05:00Z'),
      threshold: 15,
      nextProbeAt: new Date('2026-03-04T04:00:00Z'),
      reason: 'upstream_429_consecutive_rate_limit',
      requestId: 'req_429',
      attemptNo: 3
    });

    expect(result).toEqual({
      status: 'active',
      consecutiveRateLimits: 5,
      rateLimitedUntil: new Date('2026-03-04T00:05:00.000Z'),
      newlyMaxed: false
    });
    expect(db.queries[0].sql).toContain('consecutive_rate_limit_count');
    expect(db.queries[0].sql).toContain('rate_limited_until');
    expect(db.queries[0].sql).not.toContain('::boolean');
    expect(db.queries[0].sql).toContain('$6::text is not null');
    expect(db.queries[0].sql).not.toContain('$7');
    expect(db.queries[0].params).toEqual([
      'cred_1',
      5,
      new Date('2026-03-04T00:05:00Z'),
      15,
      new Date('2026-03-04T04:00:00Z'),
      'upstream_429_consecutive_rate_limit'
    ]);
  });

  it('promotes repeated 429s into maxed when the hard threshold is reached', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{
          previous_status: 'active',
          org_id: '00000000-0000-0000-0000-000000000001',
          provider: 'anthropic',
          status: 'maxed',
          consecutive_rate_limits: 15,
          rate_limited_until: null
        }],
        rowCount: 1
      },
      { rows: [], rowCount: 1 }
    ]);
    const repo = new TokenCredentialRepository(db);

    const result = await repo.recordRateLimitAndMaybeMax({
      id: 'cred_1',
      statusCode: 429,
      cooldownThreshold: 5,
      cooldownUntil: new Date('2026-03-04T00:05:00Z'),
      threshold: 15,
      nextProbeAt: new Date('2026-03-04T04:00:00Z'),
      reason: 'upstream_429_consecutive_rate_limit',
      requestId: 'req_429_hard',
      attemptNo: 4
    });

    expect(result).toEqual({
      status: 'maxed',
      consecutiveRateLimits: 15,
      rateLimitedUntil: null,
      newlyMaxed: true
    });
    expect(db.queries[1].sql).toContain("'maxed'");
    expect(db.queries[1].params?.[6]).toMatchObject({
      requestId: 'req_429_hard',
      attemptNo: 4,
      statusCode: 429,
      threshold: 15,
      cooldownThreshold: 5,
      consecutiveRateLimits: 15
    });
  });

  it('reactivates maxed credential and clears probe/failure fields', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{
          org_id: '00000000-0000-0000-0000-000000000001',
          provider: 'anthropic',
          maxed_at: '2026-03-03T00:00:00Z',
          last_probe_at: '2026-03-04T00:00:00Z'
        }],
        rowCount: 1
      },
      { rows: [], rowCount: 1 }
    ]);
    const repo = new TokenCredentialRepository(db);

    const ok = await repo.reactivateFromMaxed('cred_1');
    expect(ok).toBe(true);
    expect(db.queries[0].sql).toContain("status = 'active'");
    expect(db.queries[0].sql).toContain('consecutive_failure_count = 0');
    expect(db.queries[0].sql).toContain('consecutive_rate_limit_count = 0');
    expect(db.queries[0].sql).toContain('next_probe_at = null');
    expect(db.queries[1].sql).toContain('insert into in_token_credential_events');
    expect(db.queries[1].sql).toContain("'reactivated'");
    expect(db.queries[1].params?.[4]).toMatchObject({
      previousMaxedAt: '2026-03-03T00:00:00.000Z',
      probeSucceededAt: '2026-03-04T00:00:00.000Z'
    });
  });

  it('records failed probe metadata with next probe and prior maxed timestamp', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{
          org_id: '00000000-0000-0000-0000-000000000001',
          provider: 'openai',
          maxed_at: '2026-03-02T00:00:00Z'
        }],
        rowCount: 1
      },
      { rows: [], rowCount: 1 }
    ]);
    const repo = new TokenCredentialRepository(db);

    const ok = await repo.markProbeFailure(
      'cred_1',
      new Date('2026-03-05T00:00:00Z'),
      'probe_failed:status_401:401'
    );

    expect(ok).toBe(true);
    expect(db.queries[1].sql).toContain("'probe_failed'");
    expect(db.queries[1].params?.[5]).toMatchObject({
      nextProbeAt: '2026-03-05T00:00:00.000Z',
      previousMaxedAt: '2026-03-02T00:00:00.000Z'
    });
  });

  it('refreshes a credential in place without changing rotation_version', async () => {
    process.env.SELLER_SECRET_ENC_KEY_B64 = Buffer.alloc(32, 13).toString('base64');
    const db = new SequenceSqlClient([{
      rows: [{
        id: 'cred_1',
        org_id: '00000000-0000-0000-0000-000000000001',
        provider: 'openai',
        auth_scheme: 'bearer',
        encrypted_access_token: encryptSecret('access-new'),
        encrypted_refresh_token: encryptSecret('refresh-new'),
        expires_at: '2026-03-02T00:00:00Z',
        status: 'active',
        rotation_version: 7,
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

    const updated = await repo.refreshInPlace({
      id: 'cred_1',
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      expiresAt: new Date('2026-03-02T00:00:00Z')
    });

    expect(updated?.rotationVersion).toBe(7);
    expect(db.queries[0].sql).not.toContain('rotation_version = rotation_version + 1');
    expect(db.queries[0].sql).toContain('consecutive_rate_limit_count = 0');
  });
});
