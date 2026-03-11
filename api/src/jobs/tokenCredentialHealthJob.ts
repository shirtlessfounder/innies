import { TokenCredentialRepository, type TokenCredential } from '../repos/tokenCredentialRepository.js';
import type { JobDefinition } from './types.js';
import { isOpenAiOauthAccessToken, resolveOpenAiOauthAccountId } from '../utils/openaiOauth.js';

const DEFAULT_SCHEDULE_MS = 60 * 60 * 1000;

const ANTHROPIC_DEFAULT_BETAS = [
  'fine-grained-tool-streaming-2025-05-14',
  'interleaved-thinking-2025-05-14'
] as const;

const ANTHROPIC_OAUTH_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  ...ANTHROPIC_DEFAULT_BETAS
] as const;

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
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

async function probeCredential(credential: TokenCredential, timeoutMs: number): Promise<ProbeResult> {
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

export function createTokenCredentialHealthJob(repo: TokenCredentialRepository): JobDefinition {
  return {
    name: 'token-credential-healthcheck-hourly',
    scheduleMs: readIntEnv('TOKEN_CREDENTIAL_PROBE_SCHEDULE_MS', DEFAULT_SCHEDULE_MS),
    async run(ctx) {
      if (!envFlag('TOKEN_CREDENTIAL_PROBE_ENABLED', true)) {
        ctx.logger.info('token credential healthcheck skipped (disabled)');
        return;
      }

      const maxKeys = readIntEnv('TOKEN_CREDENTIAL_PROBE_MAX_KEYS', 20);
      const timeoutMs = readIntEnv('TOKEN_CREDENTIAL_PROBE_TIMEOUT_MS', 10000);
      const probeIntervalHours = readIntEnv('TOKEN_CREDENTIAL_PROBE_INTERVAL_HOURS', 2);
      const candidates = await repo.listMaxedForProbe(maxKeys);

      let reactivated = 0;
      let stillMaxed = 0;

      for (const credential of candidates) {
        const result = await probeCredential(credential, timeoutMs);
        if (result.ok) {
          const ok = await repo.reactivateFromMaxed(credential.id);
          if (ok) {
            reactivated += 1;
            ctx.logger.info('token credential reactivated', {
              credentialId: credential.id,
              credentialLabel: credential.debugLabel ?? null,
              provider: credential.provider
            });
          }
          continue;
        }

        const nextProbeAt = new Date(Date.now() + (probeIntervalHours * 60 * 60 * 1000));
        await repo.markProbeFailure(
          credential.id,
          nextProbeAt,
          `probe_failed:${result.reason}${result.statusCode ? `:${result.statusCode}` : ''}`
        );
        stillMaxed += 1;
      }

      ctx.logger.info('token credential healthcheck complete', {
        checked: candidates.length,
        reactivated,
        stillMaxed
      });
    }
  };
}
