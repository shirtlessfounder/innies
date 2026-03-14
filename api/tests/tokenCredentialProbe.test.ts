import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeAndUpdateTokenCredential } from '../src/services/tokenCredentialProbe.js';

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
});
