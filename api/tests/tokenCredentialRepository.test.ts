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

function createMissingContributionCapColumnError(column: 'five_hour_reserve_percent' | 'seven_day_reserve_percent'): Error {
  return Object.assign(new Error(`column "${column}" does not exist`), {
    code: '42703',
    column
  });
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

  it('treats canonical openai routing reads as including legacy codex credentials', async () => {
    process.env.SELLER_SECRET_ENC_KEY_B64 = Buffer.alloc(32, 23).toString('base64');
    const db = new SequenceSqlClient([{
      rows: [{
        id: 'cred_codex_1',
        org_id: '00000000-0000-0000-0000-000000000001',
        provider: 'codex',
        auth_scheme: 'bearer',
        encrypted_access_token: encryptSecret('codex-session-live'),
        encrypted_refresh_token: encryptSecret('codex-refresh-live'),
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

    const [found] = await repo.listActiveForRouting('00000000-0000-0000-0000-000000000001', 'openai');

    expect(found?.provider).toBe('codex');
    expect(found?.accessToken).toBe('codex-session-live');
    expect(db.queries[0].sql).toContain('provider = ANY($2::text[])');
    expect(db.queries[0].params).toEqual([
      '00000000-0000-0000-0000-000000000001',
      ['openai', 'codex']
    ]);
  });

  it('falls back cleanly when contribution-cap columns are missing from routing reads', async () => {
    process.env.SELLER_SECRET_ENC_KEY_B64 = Buffer.alloc(32, 10).toString('base64');
    const db = new SequenceSqlClient([
      createMissingContributionCapColumnError('five_hour_reserve_percent'),
      {
        rows: [{
          id: 'cred_legacy_1',
          org_id: '00000000-0000-0000-0000-000000000001',
          provider: 'anthropic',
          auth_scheme: 'x_api_key',
          encrypted_access_token: encryptSecret('access-legacy'),
          encrypted_refresh_token: encryptSecret('refresh-legacy'),
          expires_at: '2026-03-02T00:00:00Z',
          status: 'active',
          rotation_version: 1,
          created_at: '2026-03-01T00:00:00Z',
          updated_at: '2026-03-01T00:00:00Z',
          revoked_at: null,
          monthly_contribution_limit_units: null,
          monthly_contribution_used_units: 0,
          monthly_window_start_at: '2026-03-01T00:00:00Z',
          five_hour_reserve_percent: 0,
          seven_day_reserve_percent: 0,
          debug_label: null,
          consecutive_failure_count: 0,
          consecutive_rate_limit_count: 0,
          last_failed_status: null,
          last_failed_at: null,
          last_rate_limited_at: null,
          maxed_at: null,
          rate_limited_until: null,
          next_probe_at: null,
          last_probe_at: null
        }],
        rowCount: 1
      }
    ]);
    const repo = new TokenCredentialRepository(db);

    const [found] = await repo.listActiveForRouting('00000000-0000-0000-0000-000000000001', 'anthropic');

    expect(found?.accessToken).toBe('access-legacy');
    expect(found?.fiveHourReservePercent).toBe(0);
    expect(found?.sevenDayReservePercent).toBe(0);
    expect(db.queries).toHaveLength(2);
    expect(db.queries[0].sql).toContain('five_hour_reserve_percent');
    expect(db.queries[1].sql).toContain('0::integer as five_hour_reserve_percent');
    expect(db.queries[1].sql).toContain('0::integer as seven_day_reserve_percent');
  });

  it('rotates active credential with deterministic status updates', async () => {
    process.env.SELLER_SECRET_ENC_KEY_B64 = Buffer.alloc(32, 11).toString('base64');
    const db = new SequenceSqlClient([
      { rows: [{ id: 'latest_1', rotation_version: 2 }], rowCount: 1 },
      { rows: [{ id: 'old_1', status: 'active', debug_label: 'oauth-main-1' }], rowCount: 1 },
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
    expect(db.queries[3].params?.[8]).toBe('oauth-main-1');
  });

  it('rotates selected maxed credential by revoking it directly', async () => {
    process.env.SELLER_SECRET_ENC_KEY_B64 = Buffer.alloc(32, 12).toString('base64');
    const db = new SequenceSqlClient([
      { rows: [{ id: 'latest_1', rotation_version: 4 }], rowCount: 1 },
      { rows: [{ id: 'old_maxed_1', status: 'maxed', debug_label: 'darryn' }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 }
    ]);
    const repo = new TokenCredentialRepository(db);

    const rotated = await repo.rotate({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'anthropic',
      authScheme: 'bearer',
      accessToken: 'next-token',
      refreshToken: 'next-refresh',
      expiresAt: new Date('2026-03-02T00:00:00Z'),
      previousCredentialId: 'old_maxed_1'
    });

    expect(rotated.rotationVersion).toBe(5);
    expect(rotated.previousId).toBe('old_maxed_1');
    expect(db.queries).toHaveLength(4);
    expect(db.queries[2].sql).toContain('insert into in_token_credentials');
    expect(db.queries[2].params?.[8]).toBe('darryn');
    expect(db.queries[3].sql).toContain("set status = 'revoked'");
  });

  it('lists active provider poll candidates without relying on stored auth_scheme', async () => {
    process.env.SELLER_SECRET_ENC_KEY_B64 = Buffer.alloc(32, 21).toString('base64');
    const db = new SequenceSqlClient([{
      rows: [{
        id: 'cred_oauth_1',
        org_id: '00000000-0000-0000-0000-000000000001',
        provider: 'anthropic',
        auth_scheme: 'x_api_key',
        encrypted_access_token: encryptSecret('sk-ant-oat01-oauth-access'),
        encrypted_refresh_token: encryptSecret('oauth-refresh'),
        expires_at: '2026-03-02T00:00:00Z',
        status: 'active',
        rotation_version: 3,
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-01T01:00:00Z',
        revoked_at: null,
        monthly_contribution_limit_units: null,
        monthly_contribution_used_units: 0,
        monthly_window_start_at: '2026-03-01T00:00:00Z',
        five_hour_reserve_percent: 20,
        seven_day_reserve_percent: 15,
        debug_label: 'claude-oauth-1'
      }],
      rowCount: 1
    }]);
    const repo = new TokenCredentialRepository(db);

    const [found] = await repo.listActiveOauthByProvider('anthropic');

    expect(found?.authScheme).toBe('x_api_key');
    expect(found?.accessToken).toBe('sk-ant-oat01-oauth-access');
    expect(found?.fiveHourReservePercent).toBe(20);
    expect(found?.sevenDayReservePercent).toBe(15);
    expect(db.queries[0].sql).not.toContain("auth_scheme = 'bearer'");
    expect(db.queries[0].sql).toContain("status = 'active'");
    expect(db.queries[0].params).toEqual(['anthropic', false]);
  });

  it('includes expired provider poll candidates when a refresh token is available and recovery is enabled', async () => {
    process.env.SELLER_SECRET_ENC_KEY_B64 = Buffer.alloc(32, 22).toString('base64');
    const db = new SequenceSqlClient([{
      rows: [{
        id: 'cred_oauth_expired',
        org_id: '00000000-0000-0000-0000-000000000001',
        provider: 'anthropic',
        auth_scheme: 'bearer',
        encrypted_access_token: encryptSecret('sk-ant-oat01-expired'),
        encrypted_refresh_token: encryptSecret('oauth-refresh-live'),
        expires_at: '2026-03-01T00:00:00Z',
        status: 'expired',
        rotation_version: 4,
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-01T02:00:00Z',
        revoked_at: null,
        monthly_contribution_limit_units: null,
        monthly_contribution_used_units: 0,
        monthly_window_start_at: '2026-03-01T00:00:00Z',
        five_hour_reserve_percent: 10,
        seven_day_reserve_percent: 15,
        debug_label: 'claude-oauth-expired'
      }],
      rowCount: 1
    }]);
    const repo = new TokenCredentialRepository(db);

    const [found] = await repo.listActiveOauthByProvider('anthropic', {
      includeRecoverableExpired: true
    });

    expect(found?.status).toBe('expired');
    expect(found?.refreshToken).toBe('oauth-refresh-live');
    expect(db.queries[0].sql).toContain("status in ('active', 'expired')");
    expect(db.queries[0].sql).toContain('encrypted_refresh_token is not null');
    expect(db.queries[0].params).toEqual(['anthropic', true]);
  });

  it('falls back cleanly when contribution-cap columns are missing from maxed probe reads', async () => {
    process.env.SELLER_SECRET_ENC_KEY_B64 = Buffer.alloc(32, 23).toString('base64');
    const db = new SequenceSqlClient([
      createMissingContributionCapColumnError('seven_day_reserve_percent'),
      {
        rows: [{
          id: 'cred_maxed_1',
          org_id: '00000000-0000-0000-0000-000000000001',
          provider: 'anthropic',
          auth_scheme: 'bearer',
          encrypted_access_token: encryptSecret('sk-ant-oat01-maxed'),
          encrypted_refresh_token: encryptSecret('oauth-refresh'),
          expires_at: '2026-03-02T00:00:00Z',
          status: 'maxed',
          rotation_version: 4,
          created_at: '2026-03-01T00:00:00Z',
          updated_at: '2026-03-01T00:00:00Z',
          revoked_at: null,
          monthly_contribution_limit_units: null,
          monthly_contribution_used_units: 0,
          monthly_window_start_at: '2026-03-01T00:00:00Z',
          five_hour_reserve_percent: 0,
          seven_day_reserve_percent: 0,
          debug_label: 'claude-maxed-1',
          consecutive_failure_count: 0,
          consecutive_rate_limit_count: 0,
          last_failed_status: null,
          last_failed_at: null,
          last_rate_limited_at: null,
          maxed_at: '2026-03-01T01:00:00Z',
          rate_limited_until: null,
          next_probe_at: '2026-03-01T02:00:00Z',
          last_probe_at: null
        }],
        rowCount: 1
      }
    ]);
    const repo = new TokenCredentialRepository(db);

    const [found] = await repo.listMaxedForProbe(5);

    expect(found?.status).toBe('maxed');
    expect(found?.fiveHourReservePercent).toBe(0);
    expect(found?.sevenDayReservePercent).toBe(0);
    expect(db.queries).toHaveLength(2);
    expect(db.queries[1].sql).toContain('0::integer as five_hour_reserve_percent');
    expect(db.queries[1].sql).toContain('0::integer as seven_day_reserve_percent');
  });

  it('increments monthly contribution usage when under cap', async () => {
    const db = new SequenceSqlClient([{ rows: [], rowCount: 1 }]);
    const repo = new TokenCredentialRepository(db);

    const ok = await repo.addMonthlyContributionUsage('cred_1', 120);
    expect(ok).toBe(true);
    expect(db.queries[0].sql).toContain('monthly_contribution_used_units');
  });

  it('updates contribution-cap reserve fields without touching other token state', async () => {
    const db = new SequenceSqlClient([{
      rows: [{
        id: 'cred_1',
        org_id: '00000000-0000-0000-0000-000000000001',
        provider: 'anthropic',
        five_hour_reserve_percent: 35,
        seven_day_reserve_percent: 10
      }],
      rowCount: 1
    }]);
    const repo = new TokenCredentialRepository(db);

    const updated = await repo.updateContributionCap('cred_1', {
      fiveHourReservePercent: 35,
      sevenDayReservePercent: 10
    });

    expect(updated).toEqual({
      id: 'cred_1',
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'anthropic',
      fiveHourReservePercent: 35,
      sevenDayReservePercent: 10
    });
    expect(db.queries[0].sql).toContain('five_hour_reserve_percent');
    expect(db.queries[0].sql).toContain('seven_day_reserve_percent');
    expect(db.queries[0].sql).toContain('updated_at = now()');
    expect(db.queries[0].sql).toContain("and provider = 'anthropic'");
  });

  it('updates debug_label without rotating or reviving revoked credentials', async () => {
    const db = new SequenceSqlClient([{
      rows: [{
        id: 'cred_1',
        org_id: '00000000-0000-0000-0000-000000000001',
        provider: 'openai',
        debug_label: 'codex-main-2'
      }],
      rowCount: 1
    }]);
    const repo = new TokenCredentialRepository(db);

    const updated = await repo.updateDebugLabel('cred_1', 'codex-main-2');

    expect(updated).toEqual({
      id: 'cred_1',
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      debugLabel: 'codex-main-2'
    });
    expect(db.queries[0].sql).toContain('debug_label = $2');
    expect(db.queries[0].sql).toContain('updated_at = now()');
    expect(db.queries[0].sql).toContain("status <> 'revoked'");
    expect(db.queries[0].params).toEqual(['cred_1', 'codex-main-2']);
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

  it('records repeated 429s into the unified rate-limit cooldown without maxing', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{
          previous_status: 'active',
          org_id: '00000000-0000-0000-0000-000000000001',
          provider: 'anthropic',
          status: 'active',
          consecutive_rate_limits: 10,
          rate_limited_until: '2026-03-04T00:05:00Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new TokenCredentialRepository(db);

    const result = await repo.recordRateLimitAndMaybeMax({
      id: 'cred_1',
      statusCode: 429,
      cooldownThreshold: 10,
      cooldownUntil: new Date('2026-03-04T00:05:00Z'),
      threshold: 10,
      nextProbeAt: new Date('2026-03-04T04:00:00Z'),
      reason: 'upstream_429_consecutive_rate_limit',
      requestId: 'req_429',
      attemptNo: 3
    });

    expect(result).toEqual({
      status: 'active',
      consecutiveRateLimits: 10,
      rateLimitedUntil: new Date('2026-03-04T00:05:00.000Z'),
      newlyMaxed: false
    });
    expect(db.queries[0].sql).toContain('consecutive_rate_limit_count');
    expect(db.queries[0].sql).toContain('rate_limited_until');
    expect(db.queries[0].sql).not.toContain("then 'maxed'");
    expect(db.queries[0].sql).not.toContain('next_probe_at');
    expect(db.queries[0].sql).not.toContain('::boolean');
    expect(db.queries[0].sql).toContain('$6::text is not null');
    expect(db.queries[0].sql).not.toContain('$7');
    expect(db.queries[0].params).toEqual([
      'cred_1',
      10,
      new Date('2026-03-04T00:05:00Z'),
      10,
      new Date('2026-03-04T04:00:00Z'),
      'upstream_429_consecutive_rate_limit'
    ]);
  });

  it('keeps repeated 429s rate-limited instead of maxing when the threshold is reached', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{
          previous_status: 'active',
          org_id: '00000000-0000-0000-0000-000000000001',
          provider: 'anthropic',
          status: 'active',
          consecutive_rate_limits: 10,
          rate_limited_until: '2026-03-04T00:05:00Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new TokenCredentialRepository(db);

    const result = await repo.recordRateLimitAndMaybeMax({
      id: 'cred_1',
      statusCode: 429,
      cooldownThreshold: 10,
      cooldownUntil: new Date('2026-03-04T00:05:00Z'),
      threshold: 10,
      nextProbeAt: new Date('2026-03-04T04:00:00Z'),
      reason: 'upstream_429_consecutive_rate_limit',
      requestId: 'req_429_hard',
      attemptNo: 4
    });

    expect(result).toEqual({
      status: 'active',
      consecutiveRateLimits: 10,
      rateLimitedUntil: new Date('2026-03-04T00:05:00.000Z'),
      newlyMaxed: false
    });
    expect(db.queries).toHaveLength(1);
  });

  it('records repeated Claude 429s into extended local backoff without maxing', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{
          status: 'active',
          consecutive_rate_limits: 10,
          rate_limited_until: '2026-03-04T01:00:00Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new TokenCredentialRepository(db);

    const result = await repo.recordRateLimitAndApplyCooldown({
      id: 'cred_1',
      statusCode: 429,
      cooldownThreshold: 10,
      cooldownUntil: new Date('2026-03-04T00:05:00Z'),
      escalationThreshold: 10,
      escalationCooldownUntil: new Date('2026-03-04T01:00:00Z'),
      reason: 'upstream_429_consecutive_rate_limit'
    });

    expect(result).toEqual({
      status: 'active',
      consecutiveRateLimits: 10,
      rateLimitedUntil: new Date('2026-03-04T01:00:00.000Z'),
      backoffKind: 'extended'
    });
    expect(db.queries[0].sql).toContain('consecutive_rate_limit_count');
    expect(db.queries[0].sql).toContain('rate_limited_until');
    expect(db.queries[0].sql).not.toContain("then 'maxed'");
    expect(db.queries[0].sql).not.toContain('next_probe_at');
    expect(db.queries[0].params).toEqual([
      'cred_1',
      10,
      new Date('2026-03-04T00:05:00Z'),
      10,
      new Date('2026-03-04T01:00:00Z'),
      'upstream_429_consecutive_rate_limit'
    ]);
  });

  it('records Claude contribution-cap exhausted and cleared transitions per window', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 1 },
      {
        rows: [{
          event_type: 'contribution_cap_exhausted',
          created_at: '2026-03-03T00:00:00Z'
        }],
        rowCount: 1
      },
      { rows: [], rowCount: 1 }
    ]);
    const repo = new TokenCredentialRepository(db);

    const result = await repo.syncClaudeContributionCapLifecycle({
      id: 'cred_1',
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'anthropic',
      snapshotFetchedAt: new Date('2026-03-04T00:00:00Z'),
      fiveHourReservePercent: 20,
      fiveHourUtilizationRatio: 0.81,
      fiveHourResetsAt: new Date('2026-03-04T05:00:00Z'),
      fiveHourSharedThresholdPercent: 80,
      fiveHourContributionCapExhausted: true,
      sevenDayReservePercent: 10,
      sevenDayUtilizationRatio: 0.65,
      sevenDayResetsAt: new Date('2026-03-09T00:00:00Z'),
      sevenDaySharedThresholdPercent: 90,
      sevenDayContributionCapExhausted: false
    });

    expect(result).toEqual({
      fiveHourTransition: 'exhausted',
      sevenDayTransition: 'cleared'
    });
    expect(db.queries[0].sql).toContain('pg_advisory_xact_lock');
    expect(db.queries[2].params?.[4]).toBe('contribution_cap_exhausted');
    expect(db.queries[2].params?.[5]).toBe('provider_usage_5h_threshold_reached');
    expect(db.queries[2].params?.[6]).toMatchObject({
      window: '5h',
      reservePercent: 20,
      utilizationRatio: 0.81,
      sharedThresholdPercent: 80,
      resetsAt: '2026-03-04T05:00:00.000Z',
      previousEventType: null,
      previousEventAt: null
    });
    expect(db.queries[4].params?.[4]).toBe('contribution_cap_cleared');
    expect(db.queries[4].params?.[5]).toBe('provider_usage_7d_threshold_cleared');
    expect(db.queries[4].params?.[6]).toMatchObject({
      window: '7d',
      reservePercent: 10,
      utilizationRatio: 0.65,
      sharedThresholdPercent: 90,
      resetsAt: '2026-03-09T00:00:00.000Z',
      previousEventType: 'contribution_cap_exhausted',
      previousEventAt: '2026-03-03T00:00:00.000Z'
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

  it('pauses an active credential and records a lifecycle event', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{
          org_id: '00000000-0000-0000-0000-000000000001',
          provider: 'anthropic',
          rate_limited_until: '2026-03-04T01:00:00Z'
        }],
        rowCount: 1
      },
      { rows: [], rowCount: 1 }
    ]);
    const repo = new TokenCredentialRepository(db);

    const ok = await repo.pause('cred_1');

    expect(ok).toBe(true);
    expect(db.queries[0].sql).toContain("status = 'paused'");
    expect(db.queries[1].sql).toContain("'paused'");
    expect(db.queries[1].params?.[4]).toBe('manual_pause');
    expect(db.queries[1].params?.[5]).toMatchObject({
      previousStatus: 'active',
      rateLimitedUntil: '2026-03-04T01:00:00.000Z'
    });
  });

  it('unpauses a paused credential and records a lifecycle event', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{
          org_id: '00000000-0000-0000-0000-000000000001',
          provider: 'openai',
          rate_limited_until: null
        }],
        rowCount: 1
      },
      { rows: [], rowCount: 1 }
    ]);
    const repo = new TokenCredentialRepository(db);

    const ok = await repo.unpause('cred_1');

    expect(ok).toBe(true);
    expect(db.queries[0].sql).toContain("status = 'active'");
    expect(db.queries[0].sql).toContain("status = 'paused'");
    expect(db.queries[1].sql).toContain("'unpaused'");
    expect(db.queries[1].params?.[4]).toBe('manual_unpause');
    expect(db.queries[1].params?.[5]).toMatchObject({
      previousStatus: 'paused',
      rateLimitedUntil: null
    });
  });

  it('persists provider-usage warning state without churning unchanged rows', async () => {
    const db = new SequenceSqlClient([{ rows: [], rowCount: 1 }]);
    const repo = new TokenCredentialRepository(db);

    const ok = await repo.setProviderUsageWarning('cred_1', 'provider_usage_fetch_failed');

    expect(ok).toBe(true);
    expect(db.queries[0].sql).toContain('last_refresh_error = $2');
    expect(db.queries[0].sql).toContain("last_refresh_error like 'provider_usage_%'");
    expect(db.queries[0].sql).toContain('last_refresh_error is distinct from $2');
    expect(db.queries[0].params).toEqual(['cred_1', 'provider_usage_fetch_failed']);
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
        monthly_window_start_at: '2026-03-01T00:00:00Z',
        five_hour_reserve_percent: 0,
        seven_day_reserve_percent: 0,
        debug_label: 'codex-1',
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
    expect(db.queries[0].sql).toContain('consecutive_failure_count = 0');
    expect(db.queries[0].sql).toContain('consecutive_rate_limit_count = 0');
    expect(db.queries[0].sql).toContain('last_failed_status = null');
    expect(db.queries[0].sql).toContain('last_failed_at = null');
    expect(db.queries[0].sql).toContain('last_rate_limited_at = null');
    expect(db.queries[0].sql).toContain('maxed_at = null');
    expect(db.queries[0].sql).toContain('next_probe_at = null');
    expect(db.queries[0].sql).toContain('last_probe_at = now()');
  });
});
