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

  it('keeps credential maxed and schedules next probe on failed probe', async () => {
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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const job = createTokenCredentialHealthJob(repo as any);
    const ctx = createCtx();

    await job.run(ctx as any);

    expect(repo.markProbeFailure).toHaveBeenCalledTimes(1);
    expect(repo.reactivateFromMaxed).not.toHaveBeenCalled();
  });

  it('reactivates credential on successful probe', async () => {
    const repo = {
      listMaxedForProbe: vi.fn(async () => [{
        id: 'cred_1',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-good',
        debugLabel: 'oauth-main-2'
      }]),
      markProbeFailure: vi.fn(async () => true),
      reactivateFromMaxed: vi.fn(async () => true)
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'ok' }), { status: 200 }));
    const job = createTokenCredentialHealthJob(repo as any);
    const ctx = createCtx();

    await job.run(ctx as any);

    expect(repo.reactivateFromMaxed).toHaveBeenCalledWith('cred_1');
    expect(repo.markProbeFailure).not.toHaveBeenCalled();
  });
});
