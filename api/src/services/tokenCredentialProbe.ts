import { type TokenCredential, type TokenCredentialRepository } from '../repos/tokenCredentialRepository.js';
import { isOpenAiOauthAccessToken, resolveOpenAiOauthAccountId } from '../utils/openaiOauth.js';

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_INTERVAL_MINUTES = 10;

const ANTHROPIC_DEFAULT_BETAS = [
  'fine-grained-tool-streaming-2025-05-14',
  'interleaved-thinking-2025-05-14'
] as const;

const ANTHROPIC_OAUTH_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  ...ANTHROPIC_DEFAULT_BETAS
] as const;

type ProbeResult = {
  ok: boolean;
  statusCode?: number;
  reason: string;
};

type ProbeRequest = {
  targetUrl: URL;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
};

export type TokenCredentialProbeOutcome = {
  ok: boolean;
  statusCode: number | null;
  reason: string;
  reactivated: boolean;
  status: 'active' | 'maxed';
  nextProbeAt: Date | null;
};

function readIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function readTokenCredentialProbeTimeoutMs(): number {
  return readIntEnv('TOKEN_CREDENTIAL_PROBE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
}

export function readTokenCredentialProbeIntervalMinutes(): number {
  const minutes = process.env.TOKEN_CREDENTIAL_PROBE_INTERVAL_MINUTES;
  if (minutes) return readIntEnv('TOKEN_CREDENTIAL_PROBE_INTERVAL_MINUTES', DEFAULT_INTERVAL_MINUTES);

  const legacyHours = process.env.TOKEN_CREDENTIAL_PROBE_INTERVAL_HOURS;
  if (legacyHours) {
    const parsedHours = readIntEnv('TOKEN_CREDENTIAL_PROBE_INTERVAL_HOURS', Math.ceil(DEFAULT_INTERVAL_MINUTES / 60));
    return Math.max(1, parsedHours * 60);
  }

  return DEFAULT_INTERVAL_MINUTES;
}

function providerBaseUrl(provider: string): string | null {
  if (provider === 'anthropic') {
    return process.env.ANTHROPIC_UPSTREAM_BASE_URL || 'https://api.anthropic.com';
  }
  if (provider === 'openai' || provider === 'codex') {
    return process.env.OPENAI_UPSTREAM_BASE_URL || 'https://api.openai.com';
  }
  return null;
}

function isAnthropicOauthAccessToken(provider: string, accessToken: string): boolean {
  return provider === 'anthropic' && accessToken.includes('sk-ant-oat');
}

function buildProbeHeaders(credential: TokenCredential): Record<string, string> {
  const headers: Record<string, string> = {};
  if (credential.provider === 'anthropic') {
    headers['content-type'] = 'application/json';
    headers['anthropic-version'] = '2023-06-01';
  }
  if (isAnthropicOauthAccessToken(credential.provider, credential.accessToken)) {
    headers.authorization = `Bearer ${credential.accessToken}`;
    headers['anthropic-beta'] = ANTHROPIC_OAUTH_BETAS.join(',');
  } else if ((credential.provider === 'openai' || credential.provider === 'codex') && isOpenAiOauthAccessToken(credential.accessToken)) {
    headers.authorization = `Bearer ${credential.accessToken}`;
    headers.accept = 'application/json';
    headers['user-agent'] = 'CodexBar';
    const accountId = resolveOpenAiOauthAccountId(credential.accessToken);
    if (accountId) {
      headers['chatgpt-account-id'] = accountId;
    }
  } else if (credential.provider === 'openai' || credential.provider === 'codex') {
    headers.authorization = `Bearer ${credential.accessToken}`;
  } else if (credential.authScheme === 'bearer') {
    headers.authorization = `Bearer ${credential.accessToken}`;
  } else {
    headers['x-api-key'] = credential.accessToken;
  }
  return headers;
}

function buildProbeRequest(credential: TokenCredential): ProbeRequest | null {
  if ((credential.provider === 'openai' || credential.provider === 'codex') && isOpenAiOauthAccessToken(credential.accessToken)) {
    return {
      targetUrl: new URL('/backend-api/wham/usage', 'https://chatgpt.com'),
      method: 'GET',
      headers: buildProbeHeaders(credential)
    };
  }

  const baseUrl = providerBaseUrl(credential.provider);
  if (!baseUrl) return null;

  if (credential.provider === 'anthropic') {
    const model = process.env.TOKEN_CREDENTIAL_PROBE_MODEL || 'claude-opus-4-6';
    return {
      targetUrl: new URL('/v1/messages', baseUrl),
      method: 'POST',
      headers: buildProbeHeaders(credential),
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }]
      })
    };
  }

  return {
    targetUrl: new URL('/v1/models', baseUrl),
    method: 'GET',
    headers: buildProbeHeaders(credential)
  };
}

export async function probeTokenCredentialUpstream(credential: TokenCredential, timeoutMs: number): Promise<ProbeResult> {
  const request = buildProbeRequest(credential);
  if (!request) return { ok: false, reason: `unsupported_provider:${credential.provider}` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(request.targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal
    });
    if (response.ok) return { ok: true, statusCode: response.status, reason: 'ok' };
    return { ok: false, statusCode: response.status, reason: `status_${response.status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'probe_error';
    return { ok: false, reason: `network:${message}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeAndUpdateTokenCredential(
  repo: TokenCredentialRepository,
  credential: TokenCredential,
  options?: {
    timeoutMs?: number;
    probeIntervalMinutes?: number;
  }
): Promise<TokenCredentialProbeOutcome> {
  const timeoutMs = options?.timeoutMs ?? readTokenCredentialProbeTimeoutMs();
  const probeIntervalMinutes = options?.probeIntervalMinutes ?? readTokenCredentialProbeIntervalMinutes();
  const isMaxedProbe = credential.status === 'maxed' || credential.status === undefined;
  const result = await probeTokenCredentialUpstream(credential, timeoutMs);

  if (result.ok) {
    const reactivated = isMaxedProbe
      ? await repo.reactivateFromMaxed(credential.id)
      : false;
    return {
      ok: true,
      statusCode: result.statusCode ?? null,
      reason: result.reason,
      reactivated,
      status: reactivated ? 'active' : (isMaxedProbe ? 'maxed' : 'active'),
      nextProbeAt: null
    };
  }

  if (!isMaxedProbe) {
    return {
      ok: false,
      statusCode: result.statusCode ?? null,
      reason: result.reason,
      reactivated: false,
      status: 'active',
      nextProbeAt: null
    };
  }

  const nextProbeAt = new Date(Date.now() + (probeIntervalMinutes * 60 * 1000));
  await repo.markProbeFailure(
    credential.id,
    nextProbeAt,
    `probe_failed:${result.reason}${result.statusCode ? `:${result.statusCode}` : ''}`
  );

  return {
    ok: false,
    statusCode: result.statusCode ?? null,
    reason: result.reason,
    reactivated: false,
    status: 'maxed',
    nextProbeAt
  };
}
