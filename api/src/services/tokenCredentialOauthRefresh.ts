import type { TokenCredential, TokenCredentialRepository } from '../repos/tokenCredentialRepository.js';
import type { TokenCredentialProviderUsageRepository } from '../repos/tokenCredentialProviderUsageRepository.js';
import {
  anthropicOauthUsageAuthFailureStatusCode,
  type AnthropicOauthUsageRefreshOutcome,
  isAnthropicOauthTokenCredential,
  refreshAnthropicOauthUsageNow
} from './tokenCredentialProviderUsage.js';
import {
  isOpenAiOauthAccessToken,
  resolveOpenAiOauthClientId,
  resolveOpenAiOauthExpiresAt
} from '../utils/openaiOauth.js';

const DEFAULT_OPENAI_OAUTH_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const DEFAULT_ANTHROPIC_OAUTH_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const DEFAULT_ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';

function parseRefreshExpiry(
  payload: Record<string, unknown>,
  fallback: Date | null,
  resolver?: (accessToken: string) => Date | null,
  accessToken?: string
): Date | null {
  if (typeof payload.expires_at === 'string') {
    const expiresAt = new Date(payload.expires_at);
    if (!Number.isNaN(expiresAt.getTime())) return expiresAt;
  }
  if (typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0) {
    return new Date(Date.now() + (payload.expires_in * 1000));
  }
  if (accessToken && resolver) {
    const resolved = resolver(accessToken);
    if (resolved) return resolved;
  }
  return fallback;
}

function readAnthropicOauthClientId(): string {
  const configured = process.env.ANTHROPIC_OAUTH_CLIENT_ID?.trim()
    || process.env.CLAUDE_CODE_OAUTH_CLIENT_ID?.trim();
  return configured && configured.length > 0
    ? configured
    : DEFAULT_ANTHROPIC_OAUTH_CLIENT_ID;
}

export async function attemptOpenAiOauthRefresh(
  repo: TokenCredentialRepository,
  credential: TokenCredential
): Promise<TokenCredential | null> {
  if (!credential.refreshToken) return null;
  if (!isOpenAiOauthAccessToken(credential.accessToken)) return null;

  const clientId = resolveOpenAiOauthClientId(credential.accessToken);
  if (!clientId) return null;

  const refreshUrl = process.env.OPENAI_OAUTH_TOKEN_ENDPOINT || DEFAULT_OPENAI_OAUTH_TOKEN_ENDPOINT;
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: credential.refreshToken
  });

  const response = await fetch(refreshUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    },
    body: form.toString()
  }).catch(() => null);

  if (!response?.ok) return null;

  const payload = await response.json().catch(() => ({} as Record<string, unknown>));
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : null;
  if (!accessToken) return null;

  const refreshToken = typeof payload.refresh_token === 'string' && payload.refresh_token.trim().length > 0
    ? payload.refresh_token
    : credential.refreshToken;
  const expiresAt = parseRefreshExpiry(
    payload,
    credential.expiresAt,
    resolveOpenAiOauthExpiresAt,
    accessToken
  );

  return repo.refreshInPlace({
    id: credential.id,
    accessToken,
    refreshToken,
    expiresAt
  });
}

export async function attemptAnthropicOauthRefresh(
  repo: TokenCredentialRepository,
  credential: TokenCredential
): Promise<TokenCredential | null> {
  if (!credential.refreshToken) return null;
  if (!isAnthropicOauthTokenCredential(credential)) return null;

  const refreshUrl = process.env.ANTHROPIC_OAUTH_TOKEN_ENDPOINT || DEFAULT_ANTHROPIC_OAUTH_TOKEN_ENDPOINT;
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: readAnthropicOauthClientId(),
    refresh_token: credential.refreshToken
  });

  const response = await fetch(refreshUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'anthropic-beta': ANTHROPIC_OAUTH_BETA
    },
    body: form.toString()
  }).catch(() => null);

  if (!response?.ok) return null;

  const payload = await response.json().catch(() => ({} as Record<string, unknown>));
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : null;
  if (!accessToken) return null;

  const refreshToken = typeof payload.refresh_token === 'string' && payload.refresh_token.trim().length > 0
    ? payload.refresh_token
    : credential.refreshToken;
  const expiresAt = parseRefreshExpiry(payload, credential.expiresAt);

  return repo.refreshInPlace({
    id: credential.id,
    accessToken,
    refreshToken,
    expiresAt
  });
}

export async function attemptTokenCredentialRefresh(
  repo: TokenCredentialRepository,
  credential: TokenCredential
): Promise<TokenCredential | null> {
  const anthropicOauthCredential = await attemptAnthropicOauthRefresh(repo, credential);
  if (anthropicOauthCredential) return anthropicOauthCredential;

  const openAiOauthCredential = await attemptOpenAiOauthRefresh(repo, credential);
  if (openAiOauthCredential) return openAiOauthCredential;

  if (!credential.refreshToken) return null;
  const refreshUrl = process.env.TOKEN_REFRESH_ENDPOINT;
  if (!refreshUrl) return null;

  const response = await fetch(refreshUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: credential.provider,
      orgId: credential.orgId,
      refreshToken: credential.refreshToken
    })
  }).catch(() => null);

  if (!response?.ok) return null;
  const payload = await response.json().catch(() => ({} as Record<string, unknown>));
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : null;
  if (!accessToken) return null;

  const refreshToken = typeof payload.refresh_token === 'string'
    ? payload.refresh_token
    : credential.refreshToken;
  const expiresAt = parseRefreshExpiry(payload, credential.expiresAt);

  return repo.refreshInPlace({
    id: credential.id,
    accessToken,
    refreshToken,
    expiresAt
  });
}

export async function refreshAnthropicOauthUsageWithCredentialRefresh(
  providerUsageRepo: TokenCredentialProviderUsageRepository,
  tokenCredentialRepo: TokenCredentialRepository,
  credential: TokenCredential,
  options?: {
    timeoutMs?: number;
    ignoreRetryBackoff?: boolean;
  }
): Promise<{
  credential: TokenCredential;
  outcome: AnthropicOauthUsageRefreshOutcome;
  refreshedCredential: TokenCredential | null;
}> {
  const initialOutcome = await refreshAnthropicOauthUsageNow(providerUsageRepo, credential, options);
  if (anthropicOauthUsageAuthFailureStatusCode(initialOutcome) === null) {
    return {
      credential,
      outcome: initialOutcome,
      refreshedCredential: null
    };
  }

  const refreshedCredential = await attemptTokenCredentialRefresh(tokenCredentialRepo, credential);
  if (!refreshedCredential) {
    return {
      credential,
      outcome: initialOutcome,
      refreshedCredential: null
    };
  }

  const retriedOutcome = await refreshAnthropicOauthUsageNow(providerUsageRepo, refreshedCredential, {
    timeoutMs: options?.timeoutMs,
    ignoreRetryBackoff: true
  });

  return {
    credential: refreshedCredential,
    outcome: retriedOutcome,
    refreshedCredential
  };
}
