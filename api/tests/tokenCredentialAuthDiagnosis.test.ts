import { describe, expect, it } from 'vitest';
import { deriveTokenCredentialAuthDiagnosis } from '../src/services/tokenCredentialAuthDiagnosis.js';

function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function makeOpenAiOauthToken(input: {
  exp: string;
  clientId?: string;
  accountId?: string;
}): string {
  const header = encodeBase64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = encodeBase64Url(JSON.stringify({
    iss: 'https://auth.openai.com',
    aud: ['https://api.openai.com/v1'],
    client_id: input.clientId ?? 'app_test_client',
    exp: Math.floor(new Date(input.exp).getTime() / 1000),
    'https://api.openai.com/auth': {
      chatgpt_account_id: input.accountId ?? 'acct_test'
    }
  }));
  return `${header}.${payload}.sig`;
}

describe('deriveTokenCredentialAuthDiagnosis', () => {
  it('detects expired OpenAI OAuth access tokens and missing refresh state', () => {
    const diagnosis = deriveTokenCredentialAuthDiagnosis({
      provider: 'openai',
      accessToken: makeOpenAiOauthToken({ exp: '2026-03-14T15:49:35.000Z' }),
      hasRefreshToken: false,
      statusCode: 401,
      now: '2026-03-16T12:00:00.000Z'
    });

    expect(diagnosis).toEqual({
      authDiagnosis: 'access_token_expired_local',
      accessTokenExpiresAt: '2026-03-14T15:49:35.000Z',
      refreshTokenState: 'missing'
    });
  });

  it('falls back to upstream auth status when no stronger local diagnosis exists', () => {
    const diagnosis = deriveTokenCredentialAuthDiagnosis({
      provider: 'openai',
      accessToken: makeOpenAiOauthToken({ exp: '2026-03-20T15:49:35.000Z' }),
      hasRefreshToken: true,
      statusCode: 401,
      now: '2026-03-16T12:00:00.000Z'
    });

    expect(diagnosis).toEqual({
      authDiagnosis: 'upstream_status_401',
      accessTokenExpiresAt: '2026-03-20T15:49:35.000Z',
      refreshTokenState: 'present'
    });
  });

  it('returns null fields when no auth diagnosis applies', () => {
    expect(deriveTokenCredentialAuthDiagnosis({
      provider: 'anthropic',
      accessToken: 'sk-ant-oat01-live',
      hasRefreshToken: null,
      statusCode: 429
    })).toEqual({
      authDiagnosis: null,
      accessTokenExpiresAt: null,
      refreshTokenState: null
    });
  });
});
