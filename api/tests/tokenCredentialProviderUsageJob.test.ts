import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenCredentialProviderUsageJob } from '../src/jobs/tokenCredentialProviderUsageJob.js';
import { resetAnthropicUsageRetryStateForTests } from '../src/services/tokenCredentialProviderUsageRetryState.js';

function createCtx() {
  return {
    now: new Date('2026-03-04T00:00:00Z'),
    logger: {
      info: vi.fn(),
      error: vi.fn()
    }
  };
}

describe('tokenCredentialProviderUsageJob', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TOKEN_CREDENTIAL_PROVIDER_USAGE_ENABLED;
    delete process.env.TOKEN_CREDENTIAL_PROVIDER_USAGE_POLL_MS;
    delete process.env.TOKEN_CREDENTIAL_RATE_LIMIT_CONSECUTIVE_FAILURES;
    delete process.env.ANTHROPIC_OAUTH_USAGE_BASE_URL;
    delete process.env.ANTHROPIC_OAUTH_USAGE_PATH;
    delete process.env.ANTHROPIC_OAUTH_USAGE_USER_AGENT;
    resetAnthropicUsageRetryStateForTests();
  });

  it('skips when disabled', async () => {
    process.env.TOKEN_CREDENTIAL_PROVIDER_USAGE_ENABLED = 'false';
    const tokenRepo = {
      listActiveOauthByProvider: vi.fn(),
      setProviderUsageWarning: vi.fn(async () => false),
      listMaxedForProbe: vi.fn(async () => []),
      syncClaudeContributionCapLifecycle: vi.fn(async () => ({ fiveHourTransition: null, sevenDayTransition: null })),
      reactivateFromMaxed: vi.fn(async () => false)
    };
    const usageRepo = {
      upsertSnapshot: vi.fn()
    };
    const job = createTokenCredentialProviderUsageJob(tokenRepo as any, usageRepo as any);
    const ctx = createCtx();

    await job.run(ctx as any);

    expect(tokenRepo.listActiveOauthByProvider).not.toHaveBeenCalled();
    expect(ctx.logger.info).toHaveBeenCalledWith('token credential provider usage refresh skipped (disabled)');
  });

  it('fetches Anthropic oauth usage snapshots and clears repeated backoff when fresh quota state is healthy', async () => {
    process.env.ANTHROPIC_OAUTH_USAGE_BASE_URL = 'https://anthropic.internal.test';
    const tokenRepo = {
      listActiveOauthByProvider: vi.fn(async () => [{
        id: 'cred_1',
        orgId: 'org_1',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-healthy',
        refreshToken: null,
        expiresAt: new Date('2026-03-10T00:00:00Z'),
        status: 'active',
        rotationVersion: 1,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        updatedAt: new Date('2026-03-01T00:00:00Z'),
        revokedAt: null,
        monthlyContributionLimitUnits: null,
        monthlyContributionUsedUnits: 0,
        monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z'),
        fiveHourReservePercent: 20,
        sevenDayReservePercent: 0,
        debugLabel: 'claude-oauth-main',
        consecutiveFailureCount: 0,
        consecutiveRateLimitCount: 10,
        lastFailedStatus: null,
        lastFailedAt: null,
        lastRateLimitedAt: null,
        maxedAt: null,
        rateLimitedUntil: new Date('2026-03-04T00:15:00Z'),
        nextProbeAt: null,
        lastProbeAt: null
      }]),
      clearRateLimitBackoff: vi.fn(async () => true),
      setProviderUsageWarning: vi.fn(async () => false),
      listMaxedForProbe: vi.fn(async () => []),
      syncClaudeContributionCapLifecycle: vi.fn(async () => ({ fiveHourTransition: null, sevenDayTransition: null })),
      reactivateFromMaxed: vi.fn(async () => false)
    };
    const usageRepo = {
      upsertSnapshot: vi.fn(async (input: any) => ({
        tokenCredentialId: input.tokenCredentialId,
        orgId: input.orgId,
        provider: input.provider,
        usageSource: input.usageSource,
        fiveHourUtilizationRatio: input.fiveHourUtilizationRatio,
        fiveHourResetsAt: input.fiveHourResetsAt,
        sevenDayUtilizationRatio: input.sevenDayUtilizationRatio,
        sevenDayResetsAt: input.sevenDayResetsAt,
        rawPayload: input.rawPayload,
        fetchedAt: input.fetchedAt,
        createdAt: input.fetchedAt,
        updatedAt: input.fetchedAt
      }))
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        '5h': { percent: 45, resets_at: '2026-03-04T05:00:00Z' },
        '7d': { percent: 10, resets_at: '2026-03-09T00:00:00Z' }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const job = createTokenCredentialProviderUsageJob(tokenRepo as any, usageRepo as any);
    const ctx = createCtx();

    await job.run(ctx as any);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        'user-agent': 'claude-code/2.1.34',
        'anthropic-beta': 'oauth-2025-04-20'
      })
    });
    expect(usageRepo.upsertSnapshot).toHaveBeenCalledTimes(1);
    expect(tokenRepo.syncClaudeContributionCapLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      id: 'cred_1',
      fiveHourContributionCapExhausted: false,
      sevenDayContributionCapExhausted: false
    }));
    expect(tokenRepo.clearRateLimitBackoff).toHaveBeenCalledWith('cred_1', 10);
    expect(ctx.logger.info).toHaveBeenCalledWith(
      'token credential provider usage refresh complete',
      expect.objectContaining({
        checked: 1,
        refreshed: 1,
        failed: 0,
        clearedBackoff: 1
      })
    );
  });

  it('allows overriding the Anthropic oauth usage user-agent', async () => {
    process.env.ANTHROPIC_OAUTH_USAGE_BASE_URL = 'https://anthropic.internal.test';
    process.env.ANTHROPIC_OAUTH_USAGE_USER_AGENT = 'claude-code/9.9.9';
    const tokenRepo = {
      listActiveOauthByProvider: vi.fn(async () => [{
        id: 'cred_override',
        orgId: 'org_1',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-override',
        refreshToken: null,
        expiresAt: new Date('2026-03-10T00:00:00Z'),
        status: 'active',
        rotationVersion: 1,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        updatedAt: new Date('2026-03-01T00:00:00Z'),
        revokedAt: null,
        monthlyContributionLimitUnits: null,
        monthlyContributionUsedUnits: 0,
        monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z'),
        fiveHourReservePercent: 0,
        sevenDayReservePercent: 0,
        debugLabel: 'override-ua',
        consecutiveFailureCount: 0,
        consecutiveRateLimitCount: 0,
        lastFailedStatus: null,
        lastFailedAt: null,
        lastRateLimitedAt: null,
        maxedAt: null,
        rateLimitedUntil: null,
        nextProbeAt: null,
        lastProbeAt: null
      }]),
      clearRateLimitBackoff: vi.fn(async () => false),
      setProviderUsageWarning: vi.fn(async () => false),
      listMaxedForProbe: vi.fn(async () => []),
      syncClaudeContributionCapLifecycle: vi.fn(async () => ({ fiveHourTransition: null, sevenDayTransition: null })),
      reactivateFromMaxed: vi.fn(async () => false)
    };
    const usageRepo = {
      upsertSnapshot: vi.fn(async (input: any) => ({
        tokenCredentialId: input.tokenCredentialId,
        orgId: input.orgId,
        provider: input.provider,
        usageSource: input.usageSource,
        fiveHourUtilizationRatio: input.fiveHourUtilizationRatio,
        fiveHourResetsAt: input.fiveHourResetsAt,
        sevenDayUtilizationRatio: input.sevenDayUtilizationRatio,
        sevenDayResetsAt: input.sevenDayResetsAt,
        rawPayload: input.rawPayload,
        fetchedAt: input.fetchedAt,
        createdAt: input.fetchedAt,
        updatedAt: input.fetchedAt
      }))
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        five_hour: { utilization: 0.45, resets_at: '2026-03-04T05:00:00Z' },
        seven_day: { utilization: 0.1, resets_at: '2026-03-09T00:00:00Z' }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const job = createTokenCredentialProviderUsageJob(tokenRepo as any, usageRepo as any);

    await job.run(createCtx() as any);

    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        'user-agent': 'claude-code/9.9.9'
      })
    });
  });

  it('logs refresh failures without crashing the poll run', async () => {
    const tokenRepo = {
      listActiveOauthByProvider: vi.fn(async () => [{
        id: 'cred_2',
        orgId: 'org_1',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-bad',
        refreshToken: null,
        expiresAt: new Date('2026-03-10T00:00:00Z'),
        status: 'active',
        rotationVersion: 1,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        updatedAt: new Date('2026-03-01T00:00:00Z'),
        revokedAt: null,
        monthlyContributionLimitUnits: null,
        monthlyContributionUsedUnits: 0,
        monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z'),
        fiveHourReservePercent: 20,
        sevenDayReservePercent: 0,
        debugLabel: 'claude-oauth-bad',
        consecutiveFailureCount: 0,
        consecutiveRateLimitCount: 0,
        lastFailedStatus: null,
        lastFailedAt: null,
        lastRateLimitedAt: null,
        maxedAt: null,
        rateLimitedUntil: null,
        nextProbeAt: null,
        lastProbeAt: null
      }]),
      clearRateLimitBackoff: vi.fn(async () => false),
      setProviderUsageWarning: vi.fn(async () => true),
      listMaxedForProbe: vi.fn(async () => []),
      syncClaudeContributionCapLifecycle: vi.fn(async () => ({ fiveHourTransition: null, sevenDayTransition: null })),
      reactivateFromMaxed: vi.fn(async () => false)
    };
    const usageRepo = {
      upsertSnapshot: vi.fn()
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'oops' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      })
    );
    const job = createTokenCredentialProviderUsageJob(tokenRepo as any, usageRepo as any);
    const ctx = createCtx();

    await job.run(ctx as any);

    expect(usageRepo.upsertSnapshot).not.toHaveBeenCalled();
    expect(ctx.logger.error).toHaveBeenCalledWith(
      'token credential provider usage refresh failed',
      expect.objectContaining({
        credentialId: 'cred_2',
        reason: 'provider_usage_fetch_failed',
        detailReason: 'status_500',
        statusCode: 500
      })
    );
    expect(tokenRepo.setProviderUsageWarning).toHaveBeenCalledWith('cred_2', 'provider_usage_fetch_failed');
  });

  it('parks active Claude credentials when provider usage refresh returns auth failure', async () => {
    const tokenRepo = {
      listActiveOauthByProvider: vi.fn(async () => [{
        id: 'cred_auth_fail',
        orgId: 'org_1',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-expired',
        refreshToken: null,
        expiresAt: new Date('2026-03-10T00:00:00Z'),
        status: 'active',
        rotationVersion: 1,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        updatedAt: new Date('2026-03-01T00:00:00Z'),
        revokedAt: null,
        monthlyContributionLimitUnits: null,
        monthlyContributionUsedUnits: 0,
        monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z'),
        fiveHourReservePercent: 10,
        sevenDayReservePercent: 15,
        debugLabel: 'shirtless',
        consecutiveFailureCount: 0,
        consecutiveRateLimitCount: 0,
        lastFailedStatus: null,
        lastFailedAt: null,
        lastRateLimitedAt: null,
        maxedAt: null,
        rateLimitedUntil: null,
        nextProbeAt: null,
        lastProbeAt: null
      }]),
      recordFailureAndMaybeMax: vi.fn(async () => ({
        status: 'maxed',
        consecutiveFailures: 1,
        newlyMaxed: true
      })),
      markProbeFailure: vi.fn(async () => false),
      clearRateLimitBackoff: vi.fn(async () => false),
      setProviderUsageWarning: vi.fn(async () => false),
      listMaxedForProbe: vi.fn(async () => []),
      syncClaudeContributionCapLifecycle: vi.fn(async () => ({ fiveHourTransition: null, sevenDayTransition: null })),
      reactivateFromMaxed: vi.fn(async () => false)
    };
    const usageRepo = {
      upsertSnapshot: vi.fn()
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'OAuth token has expired.',
          details: { error_code: 'token_expired' }
        }
      }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    );
    const job = createTokenCredentialProviderUsageJob(tokenRepo as any, usageRepo as any);
    const ctx = createCtx();

    await job.run(ctx as any);

    expect(tokenRepo.recordFailureAndMaybeMax).toHaveBeenCalledWith(expect.objectContaining({
      id: 'cred_auth_fail',
      statusCode: 401,
      threshold: 1,
      reason: 'upstream_401_provider_usage_refresh'
    }));
    expect(tokenRepo.markProbeFailure).not.toHaveBeenCalled();
    expect(tokenRepo.setProviderUsageWarning).not.toHaveBeenCalled();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      'token credential provider usage auth failure parked',
      expect.objectContaining({
        credentialId: 'cred_auth_fail',
        credentialLabel: 'shirtless',
        statusCode: 401
      })
    );
  });

  it('refreshes expired Claude credentials before parking them on provider usage auth failure', async () => {
    process.env.ANTHROPIC_OAUTH_USAGE_BASE_URL = 'https://anthropic.internal.test';
    const tokenRepo = {
      listActiveOauthByProvider: vi.fn(async () => [{
        id: 'cred_auth_refresh',
        orgId: 'org_1',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-expired',
        refreshToken: 'rt_claude_old',
        expiresAt: new Date('2026-03-10T00:00:00Z'),
        status: 'active',
        rotationVersion: 1,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        updatedAt: new Date('2026-03-01T00:00:00Z'),
        revokedAt: null,
        monthlyContributionLimitUnits: null,
        monthlyContributionUsedUnits: 0,
        monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z'),
        fiveHourReservePercent: 10,
        sevenDayReservePercent: 15,
        debugLabel: 'shirtless',
        consecutiveFailureCount: 0,
        consecutiveRateLimitCount: 0,
        lastFailedStatus: null,
        lastFailedAt: null,
        lastRateLimitedAt: null,
        maxedAt: null,
        rateLimitedUntil: null,
        nextProbeAt: null,
        lastProbeAt: null
      }]),
      refreshInPlace: vi.fn(async () => ({
        id: 'cred_auth_refresh',
        orgId: 'org_1',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-refreshed',
        refreshToken: 'rt_claude_new',
        expiresAt: new Date('2026-03-10T01:00:00Z'),
        status: 'active',
        rotationVersion: 1,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        updatedAt: new Date('2026-03-01T00:00:00Z'),
        revokedAt: null,
        monthlyContributionLimitUnits: null,
        monthlyContributionUsedUnits: 0,
        monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z'),
        fiveHourReservePercent: 10,
        sevenDayReservePercent: 15,
        debugLabel: 'shirtless',
        consecutiveFailureCount: 0,
        consecutiveRateLimitCount: 0,
        lastFailedStatus: null,
        lastFailedAt: null,
        lastRateLimitedAt: null,
        maxedAt: null,
        rateLimitedUntil: null,
        nextProbeAt: null,
        lastProbeAt: null
      })),
      recordFailureAndMaybeMax: vi.fn(async () => ({
        status: 'maxed',
        consecutiveFailures: 1,
        newlyMaxed: true
      })),
      markProbeFailure: vi.fn(async () => false),
      clearRateLimitBackoff: vi.fn(async () => false),
      setProviderUsageWarning: vi.fn(async () => false),
      listMaxedForProbe: vi.fn(async () => []),
      syncClaudeContributionCapLifecycle: vi.fn(async () => ({ fiveHourTransition: null, sevenDayTransition: null })),
      reactivateFromMaxed: vi.fn(async () => false)
    };
    const usageRepo = {
      upsertSnapshot: vi.fn(async (input: any) => ({
        tokenCredentialId: input.tokenCredentialId,
        orgId: input.orgId,
        provider: input.provider,
        usageSource: input.usageSource,
        fiveHourUtilizationRatio: input.fiveHourUtilizationRatio,
        fiveHourResetsAt: input.fiveHourResetsAt,
        sevenDayUtilizationRatio: input.sevenDayUtilizationRatio,
        sevenDayResetsAt: input.sevenDayResetsAt,
        rawPayload: input.rawPayload,
        fetchedAt: input.fetchedAt,
        createdAt: input.fetchedAt,
        updatedAt: input.fetchedAt
      }))
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://anthropic.internal.test/api/oauth/usage') {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (headers.authorization === 'Bearer sk-ant-oat01-expired') {
          return new Response(JSON.stringify({
            type: 'error',
            error: {
              type: 'authentication_error',
              message: 'OAuth token has expired.',
              details: { error_code: 'token_expired' }
            }
          }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({
          '5h': { percent: 35, resets_at: '2026-03-04T05:00:00Z' },
          '7d': { percent: 12, resets_at: '2026-03-09T00:00:00Z' }
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url === 'https://platform.claude.com/v1/oauth/token') {
        expect(String(init?.body)).toContain('grant_type=refresh_token');
        expect(String(init?.body)).toContain('client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e');
        expect(String(init?.body)).toContain('refresh_token=rt_claude_old');
        return new Response(JSON.stringify({
          access_token: 'sk-ant-oat01-refreshed',
          refresh_token: 'rt_claude_new',
          expires_in: 3600
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`unexpected fetch target: ${url}`);
    });
    const job = createTokenCredentialProviderUsageJob(tokenRepo as any, usageRepo as any);
    const ctx = createCtx();

    await job.run(ctx as any);

    expect(tokenRepo.refreshInPlace).toHaveBeenCalledWith(expect.objectContaining({
      id: 'cred_auth_refresh',
      accessToken: 'sk-ant-oat01-refreshed',
      refreshToken: 'rt_claude_new'
    }));
    expect(tokenRepo.recordFailureAndMaybeMax).not.toHaveBeenCalled();
    expect(usageRepo.upsertSnapshot).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('contains snapshot write failures and keeps processing later credentials', async () => {
    process.env.ANTHROPIC_OAUTH_USAGE_BASE_URL = 'https://anthropic.internal.test';
    const tokenRepo = {
      listActiveOauthByProvider: vi.fn(async () => [
        {
          id: 'cred_write_fail',
          orgId: 'org_1',
          provider: 'anthropic',
          authScheme: 'bearer',
          accessToken: 'sk-ant-oat01-write-fail',
          refreshToken: null,
          expiresAt: new Date('2026-03-10T00:00:00Z'),
          status: 'active',
          rotationVersion: 1,
          createdAt: new Date('2026-03-01T00:00:00Z'),
          updatedAt: new Date('2026-03-01T00:00:00Z'),
          revokedAt: null,
          monthlyContributionLimitUnits: null,
          monthlyContributionUsedUnits: 0,
          monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z'),
          fiveHourReservePercent: 0,
          sevenDayReservePercent: 0,
          debugLabel: 'write-fail',
          consecutiveFailureCount: 0,
          consecutiveRateLimitCount: 0,
          lastFailedStatus: null,
          lastFailedAt: null,
          lastRateLimitedAt: null,
          maxedAt: null,
          rateLimitedUntil: null,
          nextProbeAt: null,
          lastProbeAt: null
        },
        {
          id: 'cred_write_ok',
          orgId: 'org_1',
          provider: 'anthropic',
          authScheme: 'bearer',
          accessToken: 'sk-ant-oat01-write-ok',
          refreshToken: null,
          expiresAt: new Date('2026-03-10T00:00:00Z'),
          status: 'active',
          rotationVersion: 1,
          createdAt: new Date('2026-03-01T00:00:00Z'),
          updatedAt: new Date('2026-03-01T00:00:00Z'),
          revokedAt: null,
          monthlyContributionLimitUnits: null,
          monthlyContributionUsedUnits: 0,
          monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z'),
          fiveHourReservePercent: 0,
          sevenDayReservePercent: 0,
          debugLabel: 'write-ok',
          consecutiveFailureCount: 0,
          consecutiveRateLimitCount: 0,
          lastFailedStatus: null,
          lastFailedAt: null,
          lastRateLimitedAt: null,
          maxedAt: null,
          rateLimitedUntil: null,
          nextProbeAt: null,
          lastProbeAt: null
        }
      ]),
      clearRateLimitBackoff: vi.fn(async () => false),
      setProviderUsageWarning: vi.fn(async () => false),
      listMaxedForProbe: vi.fn(async () => []),
      syncClaudeContributionCapLifecycle: vi.fn(async () => ({ fiveHourTransition: null, sevenDayTransition: null })),
      reactivateFromMaxed: vi.fn(async () => false)
    };
    const usageRepo = {
      upsertSnapshot: vi.fn()
        .mockRejectedValueOnce(new Error('db down'))
        .mockImplementationOnce(async (input: any) => ({
          tokenCredentialId: input.tokenCredentialId,
          orgId: input.orgId,
          provider: input.provider,
          usageSource: input.usageSource,
          fiveHourUtilizationRatio: input.fiveHourUtilizationRatio,
          fiveHourResetsAt: input.fiveHourResetsAt,
          sevenDayUtilizationRatio: input.sevenDayUtilizationRatio,
          sevenDayResetsAt: input.sevenDayResetsAt,
          rawPayload: input.rawPayload,
          fetchedAt: input.fetchedAt,
          createdAt: input.fetchedAt,
          updatedAt: input.fetchedAt
        }))
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          '5h': { percent: 40, resets_at: '2026-03-04T05:00:00Z' },
          '7d': { percent: 20, resets_at: '2026-03-09T00:00:00Z' }
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          '5h': { percent: 35, resets_at: '2026-03-04T05:00:00Z' },
          '7d': { percent: 10, resets_at: '2026-03-09T00:00:00Z' }
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );
    const job = createTokenCredentialProviderUsageJob(tokenRepo as any, usageRepo as any);
    const ctx = createCtx();

    await job.run(ctx as any);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(usageRepo.upsertSnapshot).toHaveBeenCalledTimes(2);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      'token credential provider usage refresh failed',
      expect.objectContaining({
        credentialId: 'cred_write_fail',
        reason: 'provider_usage_snapshot_write_failed',
        errorMessage: 'db down'
      })
    );
    expect(ctx.logger.info).toHaveBeenCalledWith(
      'token credential provider usage refresh complete',
      expect.objectContaining({
        checked: 2,
        refreshed: 1,
        failed: 1
      })
    );
  });

  it('backs off repeated provider-usage fetch failures per token instead of refetching every run', async () => {
    const tokenRepo = {
      listActiveOauthByProvider: vi.fn(async () => [{
        id: 'cred_backoff',
        orgId: 'org_1',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-backoff',
        refreshToken: null,
        expiresAt: new Date('2026-03-10T00:00:00Z'),
        status: 'active',
        rotationVersion: 1,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        updatedAt: new Date('2026-03-01T00:00:00Z'),
        revokedAt: null,
        monthlyContributionLimitUnits: null,
        monthlyContributionUsedUnits: 0,
        monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z'),
        fiveHourReservePercent: 0,
        sevenDayReservePercent: 0,
        debugLabel: 'backoff',
        consecutiveFailureCount: 0,
        consecutiveRateLimitCount: 0,
        lastFailedStatus: null,
        lastFailedAt: null,
        lastRateLimitedAt: null,
        maxedAt: null,
        rateLimitedUntil: null,
        nextProbeAt: null,
        lastProbeAt: null
      }]),
      clearRateLimitBackoff: vi.fn(async () => false),
      setProviderUsageWarning: vi.fn(async () => true),
      listMaxedForProbe: vi.fn(async () => []),
      syncClaudeContributionCapLifecycle: vi.fn(async () => ({ fiveHourTransition: null, sevenDayTransition: null })),
      reactivateFromMaxed: vi.fn(async () => false)
    };
    const usageRepo = {
      upsertSnapshot: vi.fn()
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'slow down' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' }
      })
    );
    const job = createTokenCredentialProviderUsageJob(tokenRepo as any, usageRepo as any);
    const ctx = createCtx();

    await job.run(ctx as any);
    await job.run(ctx as any);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(ctx.logger.info).toHaveBeenCalledWith(
      'token credential provider usage refresh deferred',
      expect.objectContaining({
        credentialId: 'cred_backoff',
        reason: 'provider_usage_fetch_failed',
        detailReason: 'provider_usage_fetch_backoff_active'
      })
    );
    expect(tokenRepo.setProviderUsageWarning).toHaveBeenCalledWith('cred_backoff', 'provider_usage_fetch_backoff_active');
  });

  it('pauses refreshes for truly 100%-exhausted active Claude tokens until the provider reset time', async () => {
    const tokenRepo = {
      listActiveOauthByProvider: vi.fn(async () => [{
        id: 'cred_full_usage',
        orgId: 'org_1',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-full-usage',
        refreshToken: null,
        expiresAt: new Date('2026-03-10T00:00:00Z'),
        status: 'active',
        rotationVersion: 1,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        updatedAt: new Date('2026-03-01T00:00:00Z'),
        revokedAt: null,
        monthlyContributionLimitUnits: null,
        monthlyContributionUsedUnits: 0,
        monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z'),
        fiveHourReservePercent: 0,
        sevenDayReservePercent: 0,
        debugLabel: 'full-usage',
        consecutiveFailureCount: 0,
        consecutiveRateLimitCount: 0,
        lastFailedStatus: null,
        lastFailedAt: null,
        lastRateLimitedAt: null,
        maxedAt: null,
        rateLimitedUntil: null,
        nextProbeAt: null,
        lastProbeAt: null
      }]),
      clearRateLimitBackoff: vi.fn(async () => false),
      setProviderUsageWarning: vi.fn(async () => true),
      listMaxedForProbe: vi.fn(async () => []),
      syncClaudeContributionCapLifecycle: vi.fn(async () => ({ fiveHourTransition: null, sevenDayTransition: null })),
      reactivateFromMaxed: vi.fn(async () => false)
    };
    const usageRepo = {
      listByTokenCredentialIds: vi.fn(async () => [{
        tokenCredentialId: 'cred_full_usage',
        orgId: 'org_1',
        provider: 'anthropic',
        usageSource: 'anthropic_oauth_usage',
        fiveHourUtilizationRatio: 1,
        fiveHourResetsAt: new Date('2026-03-04T00:30:00Z'),
        sevenDayUtilizationRatio: 0.2,
        sevenDayResetsAt: new Date('2026-03-09T00:00:00Z'),
        rawPayload: {},
        fetchedAt: new Date('2026-03-03T23:45:00Z'),
        createdAt: new Date('2026-03-03T23:45:00Z'),
        updatedAt: new Date('2026-03-03T23:45:00Z')
      }]),
      upsertSnapshot: vi.fn()
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const job = createTokenCredentialProviderUsageJob(tokenRepo as any, usageRepo as any);
    const ctx = createCtx();

    await job.run(ctx as any);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tokenRepo.setProviderUsageWarning).toHaveBeenCalledWith('cred_full_usage', null);
    expect(ctx.logger.info).toHaveBeenCalledWith(
      'token credential provider usage refresh paused (provider exhausted)',
      expect.objectContaining({
        credentialId: 'cred_full_usage',
        reason: 'usage_exhausted_5h',
        nextRefreshAt: '2026-03-04T00:30:00.000Z'
      })
    );
    expect(ctx.logger.info).toHaveBeenCalledWith(
      'token credential provider usage refresh complete',
      expect.objectContaining({
        checked: 1,
        refreshed: 0,
        paused: 1
      })
    );
  });

  it('continues refreshing manually capped Claude tokens when usage is below true provider exhaustion', async () => {
    process.env.ANTHROPIC_OAUTH_USAGE_BASE_URL = 'https://anthropic.internal.test';
    const tokenRepo = {
      listActiveOauthByProvider: vi.fn(async () => [{
        id: 'cred_manual_cap',
        orgId: 'org_1',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-manual-cap',
        refreshToken: null,
        expiresAt: new Date('2026-03-10T00:00:00Z'),
        status: 'active',
        rotationVersion: 1,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        updatedAt: new Date('2026-03-01T00:00:00Z'),
        revokedAt: null,
        monthlyContributionLimitUnits: null,
        monthlyContributionUsedUnits: 0,
        monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z'),
        fiveHourReservePercent: 20,
        sevenDayReservePercent: 0,
        debugLabel: 'manual-cap',
        consecutiveFailureCount: 0,
        consecutiveRateLimitCount: 0,
        lastFailedStatus: null,
        lastFailedAt: null,
        lastRateLimitedAt: null,
        maxedAt: null,
        rateLimitedUntil: null,
        nextProbeAt: null,
        lastProbeAt: null
      }]),
      clearRateLimitBackoff: vi.fn(async () => false),
      setProviderUsageWarning: vi.fn(async () => false),
      listMaxedForProbe: vi.fn(async () => []),
      syncClaudeContributionCapLifecycle: vi.fn(async () => ({ fiveHourTransition: null, sevenDayTransition: null })),
      reactivateFromMaxed: vi.fn(async () => false)
    };
    const usageRepo = {
      listByTokenCredentialIds: vi.fn(async () => [{
        tokenCredentialId: 'cred_manual_cap',
        orgId: 'org_1',
        provider: 'anthropic',
        usageSource: 'anthropic_oauth_usage',
        fiveHourUtilizationRatio: 0.85,
        fiveHourResetsAt: new Date('2026-03-04T00:30:00Z'),
        sevenDayUtilizationRatio: 0.2,
        sevenDayResetsAt: new Date('2026-03-09T00:00:00Z'),
        rawPayload: {},
        fetchedAt: new Date('2026-03-03T23:45:00Z'),
        createdAt: new Date('2026-03-03T23:45:00Z'),
        updatedAt: new Date('2026-03-03T23:45:00Z')
      }]),
      upsertSnapshot: vi.fn(async (input: any) => ({
        tokenCredentialId: input.tokenCredentialId,
        orgId: input.orgId,
        provider: input.provider,
        usageSource: input.usageSource,
        fiveHourUtilizationRatio: input.fiveHourUtilizationRatio,
        fiveHourResetsAt: input.fiveHourResetsAt,
        sevenDayUtilizationRatio: input.sevenDayUtilizationRatio,
        sevenDayResetsAt: input.sevenDayResetsAt,
        rawPayload: input.rawPayload,
        fetchedAt: input.fetchedAt,
        createdAt: input.fetchedAt,
        updatedAt: input.fetchedAt
      }))
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        '5h': { percent: 86, resets_at: '2026-03-04T05:00:00Z' },
        '7d': { percent: 20, resets_at: '2026-03-09T00:00:00Z' }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const job = createTokenCredentialProviderUsageJob(tokenRepo as any, usageRepo as any);

    await job.run(createCtx() as any);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(usageRepo.upsertSnapshot).toHaveBeenCalledTimes(1);
  });

  it('reactivates legacy Claude rate-limit-maxed credentials after a successful provider-usage refresh', async () => {
    process.env.ANTHROPIC_OAUTH_USAGE_BASE_URL = 'https://anthropic.internal.test';
    const tokenRepo = {
      listActiveOauthByProvider: vi.fn(async () => []),
      clearRateLimitBackoff: vi.fn(async () => false),
      setProviderUsageWarning: vi.fn(async () => false),
      listMaxedForProbe: vi.fn(async () => [{
        id: 'cred_legacy_maxed',
        orgId: 'org_1',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-legacy-maxed',
        refreshToken: null,
        expiresAt: new Date('2026-03-10T00:00:00Z'),
        status: 'maxed',
        rotationVersion: 1,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        updatedAt: new Date('2026-03-01T00:00:00Z'),
        revokedAt: null,
        monthlyContributionLimitUnits: null,
        monthlyContributionUsedUnits: 0,
        monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z'),
        fiveHourReservePercent: 20,
        sevenDayReservePercent: 0,
        debugLabel: 'legacy-maxed',
        consecutiveFailureCount: 0,
        consecutiveRateLimitCount: 15,
        lastFailedStatus: null,
        lastFailedAt: null,
        lastRateLimitedAt: new Date('2026-03-03T22:00:00Z'),
        maxedAt: new Date('2026-03-03T22:00:00Z'),
        rateLimitedUntil: null,
        nextProbeAt: new Date('2026-03-04T00:00:00Z'),
        lastProbeAt: null
      }]),
      syncClaudeContributionCapLifecycle: vi.fn(async () => ({ fiveHourTransition: null, sevenDayTransition: null })),
      reactivateFromMaxed: vi.fn(async () => true)
    };
    const usageRepo = {
      upsertSnapshot: vi.fn(async (input: any) => ({
        tokenCredentialId: input.tokenCredentialId,
        orgId: input.orgId,
        provider: input.provider,
        usageSource: input.usageSource,
        fiveHourUtilizationRatio: input.fiveHourUtilizationRatio,
        fiveHourResetsAt: input.fiveHourResetsAt,
        sevenDayUtilizationRatio: input.sevenDayUtilizationRatio,
        sevenDayResetsAt: input.sevenDayResetsAt,
        rawPayload: input.rawPayload,
        fetchedAt: input.fetchedAt,
        createdAt: input.fetchedAt,
        updatedAt: input.fetchedAt
      }))
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        '5h': { percent: 92, resets_at: '2026-03-04T05:00:00Z' },
        '7d': { percent: 30, resets_at: '2026-03-09T00:00:00Z' }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const job = createTokenCredentialProviderUsageJob(tokenRepo as any, usageRepo as any);
    const ctx = createCtx();

    await job.run(ctx as any);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(tokenRepo.setProviderUsageWarning).toHaveBeenCalledWith('cred_legacy_maxed', null);
    expect(tokenRepo.syncClaudeContributionCapLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      id: 'cred_legacy_maxed',
      fiveHourContributionCapExhausted: true,
      sevenDayContributionCapExhausted: false
    }));
    expect(tokenRepo.reactivateFromMaxed).toHaveBeenCalledWith('cred_legacy_maxed');
    expect(ctx.logger.info).toHaveBeenCalledWith(
      'token credential provider usage refresh complete',
        expect.objectContaining({
        legacyMaxedChecked: 1,
        legacyRecovered: 1
      })
    );
  });

  it('reactivates auth-failed Claude maxed credentials through the minute supervisor probe path', async () => {
    const tokenRepo = {
      listActiveOauthByProvider: vi.fn(async () => []),
      clearRateLimitBackoff: vi.fn(async () => false),
      setProviderUsageWarning: vi.fn(async () => false),
      listMaxedForProbe: vi.fn(async () => [{
        id: 'cred_auth_maxed',
        orgId: 'org_1',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-auth-maxed',
        refreshToken: null,
        expiresAt: new Date('2026-03-10T00:00:00Z'),
        status: 'maxed',
        rotationVersion: 1,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        updatedAt: new Date('2026-03-01T00:00:00Z'),
        revokedAt: null,
        monthlyContributionLimitUnits: null,
        monthlyContributionUsedUnits: 0,
        monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z'),
        fiveHourReservePercent: 0,
        sevenDayReservePercent: 0,
        debugLabel: 'auth-maxed',
        consecutiveFailureCount: 30,
        consecutiveRateLimitCount: 0,
        lastFailedStatus: 401,
        lastFailedAt: new Date('2026-03-03T22:00:00Z'),
        lastRateLimitedAt: null,
        maxedAt: new Date('2026-03-03T22:00:00Z'),
        rateLimitedUntil: null,
        nextProbeAt: new Date('2026-03-04T00:00:00Z'),
        lastProbeAt: null
      }]),
      syncClaudeContributionCapLifecycle: vi.fn(async () => ({ fiveHourTransition: null, sevenDayTransition: null })),
      reactivateFromMaxed: vi.fn(async () => true),
      markProbeFailure: vi.fn(async () => true)
    };
    const usageRepo = {
      upsertSnapshot: vi.fn()
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const job = createTokenCredentialProviderUsageJob(tokenRepo as any, usageRepo as any);
    const ctx = createCtx();

    await job.run(ctx as any);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(usageRepo.upsertSnapshot).not.toHaveBeenCalled();
    expect(tokenRepo.reactivateFromMaxed).toHaveBeenCalledWith('cred_auth_maxed');
    expect(tokenRepo.markProbeFailure).not.toHaveBeenCalled();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      'Claude auth recovery reactivated',
      expect.objectContaining({
        credentialId: 'cred_auth_maxed'
      })
    );
    expect(ctx.logger.info).toHaveBeenCalledWith(
      'token credential provider usage refresh complete',
      expect.objectContaining({
        authProbeChecked: 1,
        authProbeReactivated: 1,
        authProbeDeferred: 0
      })
    );
  });

  it('keeps legacy maxed Claude tokens parked until reset when refreshed usage is truly 100% exhausted', async () => {
    process.env.ANTHROPIC_OAUTH_USAGE_BASE_URL = 'https://anthropic.internal.test';
    const tokenRepo = {
      listActiveOauthByProvider: vi.fn(async () => []),
      clearRateLimitBackoff: vi.fn(async () => false),
      setProviderUsageWarning: vi.fn(async () => false),
      listMaxedForProbe: vi.fn(async () => [{
        id: 'cred_legacy_full',
        orgId: 'org_1',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-legacy-full',
        refreshToken: null,
        expiresAt: new Date('2026-03-10T00:00:00Z'),
        status: 'maxed',
        rotationVersion: 1,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        updatedAt: new Date('2026-03-01T00:00:00Z'),
        revokedAt: null,
        monthlyContributionLimitUnits: null,
        monthlyContributionUsedUnits: 0,
        monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z'),
        fiveHourReservePercent: 0,
        sevenDayReservePercent: 0,
        debugLabel: 'legacy-full',
        consecutiveFailureCount: 0,
        consecutiveRateLimitCount: 15,
        lastFailedStatus: null,
        lastFailedAt: null,
        lastRateLimitedAt: new Date('2026-03-03T22:00:00Z'),
        maxedAt: new Date('2026-03-03T22:00:00Z'),
        rateLimitedUntil: null,
        nextProbeAt: new Date('2026-03-04T00:00:00Z'),
        lastProbeAt: null
      }]),
      syncClaudeContributionCapLifecycle: vi.fn(async () => ({ fiveHourTransition: null, sevenDayTransition: null })),
      reactivateFromMaxed: vi.fn(async () => true),
      markProbeFailure: vi.fn(async () => true)
    };
    const usageRepo = {
      upsertSnapshot: vi.fn(async (input: any) => ({
        tokenCredentialId: input.tokenCredentialId,
        orgId: input.orgId,
        provider: input.provider,
        usageSource: input.usageSource,
        fiveHourUtilizationRatio: input.fiveHourUtilizationRatio,
        fiveHourResetsAt: input.fiveHourResetsAt,
        sevenDayUtilizationRatio: input.sevenDayUtilizationRatio,
        sevenDayResetsAt: input.sevenDayResetsAt,
        rawPayload: input.rawPayload,
        fetchedAt: input.fetchedAt,
        createdAt: input.fetchedAt,
        updatedAt: input.fetchedAt
      }))
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        '5h': { percent: 100, resets_at: '2026-03-04T00:30:00Z' },
        '7d': { percent: 40, resets_at: '2026-03-09T00:00:00Z' }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const job = createTokenCredentialProviderUsageJob(tokenRepo as any, usageRepo as any);
    const ctx = createCtx();

    await job.run(ctx as any);

    expect(tokenRepo.markProbeFailure).toHaveBeenCalledWith(
      'cred_legacy_full',
      new Date('2026-03-04T00:30:00.000Z'),
      'usage_exhausted_5h'
    );
    expect(tokenRepo.reactivateFromMaxed).not.toHaveBeenCalled();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      'legacy Claude maxed recovery deferred',
      expect.objectContaining({
        credentialId: 'cred_legacy_full',
        reason: 'usage_exhausted_5h',
        nextProbeAt: '2026-03-04T00:30:00.000Z'
      })
    );
  });
});
