import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenCredentialHealthJob } from '../src/jobs/tokenCredentialHealthJob.js';

function createCtx() {
  return {
    now: new Date('2026-03-04T00:00:00Z'),
    logger: {
      info: vi.fn(),
      error: vi.fn()
    }
  };
}

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
      chatgpt_account_id: input?.accountId ?? 'acct_codex_probe'
    }
  })).toString('base64url');
  return `${header}.${payload}.signature`;
}

describe('tokenCredentialHealthJob', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TOKEN_CREDENTIAL_PROBE_ENABLED;
    delete process.env.TOKEN_CREDENTIAL_PROBE_INTERVAL_HOURS;
    delete process.env.TOKEN_CREDENTIAL_PROBE_TIMEOUT_MS;
  });

  it('skips when disabled', async () => {
    process.env.TOKEN_CREDENTIAL_PROBE_ENABLED = 'false';
    const repo = {
      listMaxedForProbe: vi.fn()
    };
    const job = createTokenCredentialHealthJob(repo as any);
    const ctx = createCtx();

    await job.run(ctx as any);

    expect(repo.listMaxedForProbe).not.toHaveBeenCalled();
    expect(ctx.logger.info).toHaveBeenCalledWith('token credential healthcheck skipped (disabled)');
  });

  it('skips Claude oauth maxed credentials because the minute supervisor owns their recovery', async () => {
    const repo = {
      listMaxedForProbe: vi.fn(async () => [{
        id: 'cred_1',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-bad',
        debugLabel: 'oauth-main-1'
      }]),
      markProbeFailure: vi.fn(async () => true),
      reactivateFromMaxed: vi.fn(async () => false)
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const job = createTokenCredentialHealthJob(repo as any);
    const ctx = createCtx();

    await job.run(ctx as any);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(repo.reactivateFromMaxed).not.toHaveBeenCalled();
    expect(repo.markProbeFailure).not.toHaveBeenCalled();
  });

  it('probes openai/codex credentials and reactivates on success', async () => {
    const repo = {
      listMaxedForProbe: vi.fn(async () => [{
        id: 'cred_codex_1',
        provider: 'openai',
        authScheme: 'bearer',
        accessToken: 'openai-live-token',
        debugLabel: 'codex-main-1'
      }]),
      markProbeFailure: vi.fn(async () => true),
      reactivateFromMaxed: vi.fn(async () => true)
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );
    const job = createTokenCredentialHealthJob(repo as any);
    const ctx = createCtx();

    await job.run(ctx as any);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [targetUrl, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(String(targetUrl)).toContain('/v1/models');
    expect((init.method ?? '').toUpperCase()).toBe('GET');
    expect((init.headers as Record<string, string>)?.authorization).toBe('Bearer openai-live-token');
    expect(repo.reactivateFromMaxed).toHaveBeenCalledWith('cred_codex_1');
    expect(repo.markProbeFailure).not.toHaveBeenCalled();
  });

  it('probes codex oauth credentials via ChatGPT usage endpoint with account header', async () => {
    const oauthToken = createFakeOpenAiOauthToken({ accountId: 'acct_probe_live' });
    const repo = {
      listMaxedForProbe: vi.fn(async () => [{
        id: 'cred_codex_oauth_1',
        provider: 'openai',
        authScheme: 'bearer',
        accessToken: oauthToken,
        debugLabel: 'codex-oauth-main-1'
      }]),
      markProbeFailure: vi.fn(async () => true),
      reactivateFromMaxed: vi.fn(async () => true)
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ rate_limit: {} }), { status: 200 })
    );
    const job = createTokenCredentialHealthJob(repo as any);
    const ctx = createCtx();

    await job.run(ctx as any);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [targetUrl, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    const headers = (init.headers as Record<string, string>) ?? {};
    expect(String(targetUrl)).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect((init.method ?? '').toUpperCase()).toBe('GET');
    expect(headers.authorization).toBe(`Bearer ${oauthToken}`);
    expect(headers['chatgpt-account-id']).toBe('acct_probe_live');
    expect(headers['user-agent']).toBe('CodexBar');
    expect(repo.reactivateFromMaxed).toHaveBeenCalledWith('cred_codex_oauth_1');
    expect(repo.markProbeFailure).not.toHaveBeenCalled();
  });

  it('keeps openai/codex credential maxed on failed probe', async () => {
    const repo = {
      listMaxedForProbe: vi.fn(async () => [{
        id: 'cred_codex_2',
        provider: 'codex',
        authScheme: 'x_api_key',
        accessToken: 'codex-bad-token',
        debugLabel: 'codex-main-2'
      }]),
      markProbeFailure: vi.fn(async () => true),
      reactivateFromMaxed: vi.fn(async () => false)
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const job = createTokenCredentialHealthJob(repo as any);
    const ctx = createCtx();

    await job.run(ctx as any);

    expect(repo.markProbeFailure).toHaveBeenCalledTimes(1);
    expect(repo.reactivateFromMaxed).not.toHaveBeenCalled();
  });
});
