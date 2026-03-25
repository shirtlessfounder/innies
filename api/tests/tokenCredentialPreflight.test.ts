import { afterEach, describe, expect, it, vi } from 'vitest';
import { preflightValidateTokenMaterial } from '../src/services/tokenCredentialPreflight.js';

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('tokenCredentialPreflight', () => {
  it('rejects non-OAuth OpenAI tokens before probing upstream', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(preflightValidateTokenMaterial({
      provider: 'openai',
      accessToken: 'sk-live-api-key',
      refreshToken: 'rt-live-created'
    })).rejects.toThrow('Codex/OpenAI OAuth token is not valid.');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects OAuth tokens that probe as usage exhausted', async () => {
    const usageResetAt = '2026-03-24T23:07:59.000Z';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 0, reset_at: '2026-03-19T16:00:00.000Z' },
        secondary_window: { used_percent: 100, reset_at: usageResetAt }
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })));

    await expect(preflightValidateTokenMaterial({
      provider: 'openai',
      accessToken: createFakeOpenAiOauthToken({ accountId: 'acct_probe_exhausted' }),
      refreshToken: 'rt-live-created'
    })).rejects.toThrow('currently exhausted');
  });

  it('refreshes expired OpenAI OAuth token material before a successful probe', async () => {
    const refreshedAccessToken = createFakeOpenAiOauthToken({
      accountId: 'acct_probe_refreshed',
      exp: Math.floor(Date.now() / 1000) + 7200
    });
    const fetchSpy = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url === 'https://auth.openai.com/oauth/token') {
        return new Response(JSON.stringify({
          access_token: refreshedAccessToken,
          refresh_token: 'rt-live-refreshed',
          expires_in: 3600
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: 0, reset_at: '2026-03-19T16:00:00.000Z' },
          secondary_window: { used_percent: 0, reset_at: '2026-03-24T23:07:59.000Z' }
        }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await preflightValidateTokenMaterial({
      provider: 'openai',
      accessToken: createFakeOpenAiOauthToken({
        accountId: 'acct_probe_expired',
        exp: Math.floor(Date.now() / 1000) - 300
      }),
      refreshToken: 'rt-live-created'
    });

    expect(result.accessToken).toBe(refreshedAccessToken);
    expect(result.refreshToken).toBe('rt-live-refreshed');
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
