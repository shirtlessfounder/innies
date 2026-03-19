import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeAndUpdateTokenCredential } from '../src/services/tokenCredentialProbe.js';

function createFakeOpenAiOauthToken(input?: {
  accountId?: string;
  clientId?: string;
  exp?: number;
}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://auth.openai.com',
    aud: ['https://api.openai.com/v1'],
    client_id: input?.clientId ?? 'app_test_codex',
    exp: input?.exp ?? Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': {
      chatgpt_account_id: input?.accountId ?? 'acct_codex_probe'
    }
  })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function makeCredential(input: {
  id: string;
  provider?: string;
  status: 'active' | 'maxed';
  accessToken?: string;
}) {
  return {
    id: input.id,
    provider: input.provider ?? 'openai',
    authScheme: 'bearer',
    accessToken: input.accessToken ?? 'tok_live',
    status: input.status,
  } as any;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('tokenCredentialProbe', () => {
  it('keeps active credentials active after a successful manual probe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    const repo = {
      reactivateFromMaxed: vi.fn(),
      markProbeFailure: vi.fn(),
    };

    const outcome = await probeAndUpdateTokenCredential(
      repo as any,
      makeCredential({ id: 'cred_active_1', status: 'active' }),
      { timeoutMs: 50, probeIntervalMinutes: 10 }
    );

    expect(outcome).toEqual({
      ok: true,
      statusCode: 200,
      reason: 'ok',
      reactivated: false,
      status: 'active',
      nextProbeAt: null,
      authValid: true,
      availabilityOk: true,
      usageExhausted: false,
      usageExhaustedWindow: null,
      usageResetAt: null,
      refreshAttempted: false,
      refreshSucceeded: null,
      refreshReason: null,
      refreshedCredential: false,
    });
    expect(repo.reactivateFromMaxed).not.toHaveBeenCalled();
    expect(repo.markProbeFailure).not.toHaveBeenCalled();
  });

  it('treats failed active probes as diagnostic-only and does not schedule recovery state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    const repo = {
      reactivateFromMaxed: vi.fn(),
      markProbeFailure: vi.fn(),
    };

    const outcome = await probeAndUpdateTokenCredential(
      repo as any,
      makeCredential({ id: 'cred_active_2', status: 'active' }),
      { timeoutMs: 50, probeIntervalMinutes: 10 }
    );

    expect(outcome).toEqual({
      ok: false,
      statusCode: 401,
      reason: 'status_401',
      reactivated: false,
      status: 'active',
      nextProbeAt: null,
      authValid: false,
      availabilityOk: false,
      usageExhausted: false,
      usageExhaustedWindow: null,
      usageResetAt: null,
      refreshAttempted: false,
      refreshSucceeded: null,
      refreshReason: null,
      refreshedCredential: false,
    });
    expect(repo.reactivateFromMaxed).not.toHaveBeenCalled();
    expect(repo.markProbeFailure).not.toHaveBeenCalled();
  });

  it('still schedules recovery state for failed maxed probes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })));
    const repo = {
      reactivateFromMaxed: vi.fn(),
      markProbeFailure: vi.fn(async () => true),
    };

    const outcome = await probeAndUpdateTokenCredential(
      repo as any,
      makeCredential({ id: 'cred_maxed_1', status: 'maxed', provider: 'anthropic', accessToken: 'sk-ant-oat01-probe' }),
      { timeoutMs: 50, probeIntervalMinutes: 10 }
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.statusCode).toBe(429);
    expect(outcome.reason).toBe('status_429');
    expect(outcome.reactivated).toBe(false);
    expect(outcome.status).toBe('maxed');
    expect(outcome.nextProbeAt).toBeInstanceOf(Date);
    expect(repo.markProbeFailure).toHaveBeenCalledTimes(1);
  });

  it('treats a 200 WHAM exhaustion payload as auth-valid but still benched for maxed OpenAI OAuth credentials', async () => {
    const usageResetAt = new Date('2026-03-24T23:07:59.000Z');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: { used_percent: 0, reset_at: '2026-03-19T16:00:00.000Z' },
        secondary_window: { used_percent: 100, reset_at: usageResetAt.toISOString() }
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })));
    const repo = {
      reactivateFromMaxed: vi.fn(),
      markProbeFailure: vi.fn(async () => true),
    };

    const outcome = await probeAndUpdateTokenCredential(
      repo as any,
      makeCredential({
        id: 'cred_maxed_usage_exhausted',
        status: 'maxed',
        accessToken: createFakeOpenAiOauthToken({ accountId: 'acct_probe_exhausted' })
      }),
      { timeoutMs: 50, probeIntervalMinutes: 10 }
    );

    expect(outcome).toMatchObject({
      ok: false,
      statusCode: 200,
      reason: 'usage_exhausted_7d',
      reactivated: false,
      status: 'maxed',
      authValid: true,
      availabilityOk: false,
      usageExhausted: true,
      usageExhaustedWindow: '7d',
      usageResetAt
    });
    expect(outcome.nextProbeAt).toEqual(usageResetAt);
    expect(repo.reactivateFromMaxed).not.toHaveBeenCalled();
    expect(repo.markProbeFailure).toHaveBeenCalledWith(
      'cred_maxed_usage_exhausted',
      usageResetAt,
      'usage_exhausted_7d'
    );
  });

  it('treats a 200 WHAM exhaustion payload as diagnostic-only for active OpenAI OAuth credentials', async () => {
    const usageResetAt = new Date('2026-03-24T23:07:59.000Z');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: { used_percent: 0, reset_at: '2026-03-19T16:00:00.000Z' },
        secondary_window: { used_percent: 100, reset_at: usageResetAt.toISOString() }
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })));
    const repo = {
      reactivateFromMaxed: vi.fn(),
      markProbeFailure: vi.fn(async () => true),
    };

    const outcome = await probeAndUpdateTokenCredential(
      repo as any,
      makeCredential({
        id: 'cred_active_usage_exhausted',
        status: 'active',
        accessToken: createFakeOpenAiOauthToken({ accountId: 'acct_probe_active_exhausted' })
      }),
      { timeoutMs: 50, probeIntervalMinutes: 10 }
    );

    expect(outcome).toMatchObject({
      ok: false,
      statusCode: 200,
      reason: 'usage_exhausted_7d',
      reactivated: false,
      status: 'active',
      nextProbeAt: null,
      authValid: true,
      availabilityOk: false,
      usageExhausted: true,
      usageExhaustedWindow: '7d',
      usageResetAt
    });
    expect(repo.reactivateFromMaxed).not.toHaveBeenCalled();
    expect(repo.markProbeFailure).not.toHaveBeenCalled();
  });
});
