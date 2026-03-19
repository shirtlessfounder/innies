import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenCredential } from '../src/repos/tokenCredentialRepository.js';
import { refreshOpenAiOauthUsageNow } from '../src/services/tokenCredentialProviderUsage.js';

function createFakeOpenAiOauthToken(input?: {
  accountId?: string;
  clientId?: string;
  exp?: number;
}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://auth.openai.com',
    aud: ['https://api.openai.com/v1'],
    client_id: input?.clientId ?? 'app_test_codex',
    exp: input?.exp ?? Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': {
      chatgpt_account_id: input?.accountId ?? 'acct_codex_usage'
    }
  })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function createCredential(overrides?: Partial<TokenCredential>): TokenCredential {
  return {
    id: 'cred_openai_1',
    orgId: '00000000-0000-0000-0000-000000000001',
    provider: 'openai',
    authScheme: 'bearer',
    accessToken: createFakeOpenAiOauthToken(),
    refreshToken: null,
    expiresAt: new Date('2026-03-20T00:00:00Z'),
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
    debugLabel: 'codex-oauth-main',
    consecutiveFailureCount: 0,
    consecutiveRateLimitCount: 0,
    lastFailedStatus: null,
    lastFailedAt: null,
    lastRateLimitedAt: null,
    maxedAt: null,
    rateLimitedUntil: null,
    nextProbeAt: null,
    lastProbeAt: null,
    ...overrides
  };
}

function createUsageRepo() {
  return {
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
}

describe('refreshOpenAiOauthUsageNow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches openai oauth usage with bearer auth and chatgpt-account-id when derivable', async () => {
    const credential = createCredential({
      accessToken: createFakeOpenAiOauthToken({ accountId: 'acct_codex_live' })
    });
    const usageRepo = createUsageRepo();
    const payload = {
      rate_limit: {
        primary_window: {
          used_percent: 7,
          limit_window_seconds: 18_000,
          reset_at: 1_773_888_569
        },
        secondary_window: {
          used_percent: 12,
          limit_window_seconds: 604_800,
          reset_at: 1_774_457_367
        }
      }
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const outcome = await refreshOpenAiOauthUsageNow(usageRepo as any, credential, { timeoutMs: 50 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [targetUrl, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    const headers = (init.headers as Record<string, string>) ?? {};
    expect(String(targetUrl)).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect((init.method ?? '').toUpperCase()).toBe('GET');
    expect(headers.authorization).toBe(`Bearer ${credential.accessToken}`);
    expect(headers.accept).toBe('application/json');
    expect(headers['user-agent']).toBe('CodexBar');
    expect(headers['chatgpt-account-id']).toBe('acct_codex_live');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error('expected openai usage refresh to succeed');
    }
    expect(outcome.snapshot.usageSource).toBe('openai_wham_usage');
    expect(outcome.rawPayload).toEqual(payload);
  });

  it('normalizes primary and secondary wham windows into canonical openai snapshots', async () => {
    const credential = createCredential({
      provider: 'codex',
      accessToken: createFakeOpenAiOauthToken({ accountId: 'acct_codex_usage_live' })
    });
    const usageRepo = createUsageRepo();
    const payload = {
      user_id: 'user_1',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 7,
          limit_window_seconds: 18_000,
          reset_after_seconds: 14_704,
          reset_at: 1_773_888_569
        },
        secondary_window: {
          used_percent: 12,
          limit_window_seconds: 604_800,
          reset_after_seconds: 583_502,
          reset_at: 1_774_457_367
        }
      },
      additional_rate_limits: [{
        limit_name: 'GPT-5.3-Codex-Spark',
        rate_limit: {
          primary_window: {
            used_percent: 0,
            limit_window_seconds: 18_000,
            reset_at: 1_773_891_865
          },
          secondary_window: {
            used_percent: 0,
            limit_window_seconds: 604_800,
            reset_at: 1_774_478_665
          }
        }
      }]
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const outcome = await refreshOpenAiOauthUsageNow(usageRepo as any, credential, { timeoutMs: 50 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error('expected openai usage refresh to succeed');
    }
    expect(usageRepo.upsertSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      usageSource: 'openai_wham_usage',
      fiveHourUtilizationRatio: 0.07,
      sevenDayUtilizationRatio: 0.12,
      rawPayload: payload
    }));
    expect(outcome.snapshot.provider).toBe('openai');
    expect(outcome.snapshot.fiveHourResetsAt?.toISOString()).toBe(new Date(1_773_888_569 * 1000).toISOString());
    expect(outcome.snapshot.sevenDayResetsAt?.toISOString()).toBe(new Date(1_774_457_367 * 1000).toISOString());
    expect(outcome.snapshot.rawPayload).toEqual(payload);
  });

  it('returns invalid_payload when the wham usage payload is missing the mapped windows', async () => {
    const credential = createCredential();
    const usageRepo = createUsageRepo();
    const payload = {
      rate_limit: {
        primary_window: {
          limit_window_seconds: 18_000,
          reset_at: 1_773_888_569
        },
        secondary_window: null
      }
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const outcome = await refreshOpenAiOauthUsageNow(usageRepo as any, credential, { timeoutMs: 50 });

    expect(outcome).toMatchObject({
      ok: false,
      category: 'invalid_payload',
      reason: 'invalid_payload:missing_utilization',
      statusCode: 200,
      rawPayload: payload
    });
    expect(usageRepo.upsertSnapshot).not.toHaveBeenCalled();
  });

  it('surfaces upstream auth failures distinctly enough for callers to act on', async () => {
    const credential = createCredential();
    const usageRepo = createUsageRepo();
    const payload = {
      detail: 'token expired'
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    );

    const outcome = await refreshOpenAiOauthUsageNow(usageRepo as any, credential, { timeoutMs: 50 });

    expect(outcome).toMatchObject({
      ok: false,
      category: 'fetch_failed',
      reason: 'status_401',
      statusCode: 401,
      rawPayload: payload
    });
    expect(usageRepo.upsertSnapshot).not.toHaveBeenCalled();
  });

  it('rejects unsupported non-session openai credentials without calling chatgpt usage', async () => {
    const credential = createCredential({
      provider: 'openai',
      accessToken: 'openai-api-key'
    });
    const usageRepo = createUsageRepo();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const outcome = await refreshOpenAiOauthUsageNow(usageRepo as any, credential, { timeoutMs: 50 });

    expect(outcome).toMatchObject({
      ok: false,
      category: 'fetch_failed',
      reason: 'unsupported_credential',
      statusCode: null
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(usageRepo.upsertSnapshot).not.toHaveBeenCalled();
  });
});
