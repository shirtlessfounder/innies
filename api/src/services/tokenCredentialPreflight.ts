import type { TokenCredential } from '../repos/tokenCredentialRepository.js';
import { AppError } from '../utils/errors.js';
import { isOpenAiOauthAccessToken, resolveOpenAiOauthExpiresAt } from '../utils/openaiOauth.js';
import {
  probeAndUpdateTokenCredential,
  readTokenCredentialProbeIntervalMinutes,
  readTokenCredentialProbeTimeoutMs,
  type TokenCredentialProbeOutcome
} from './tokenCredentialProbe.js';

const FAR_FUTURE_EXPIRY = new Date('9999-12-31T23:59:59.999Z');

export type ValidatedTokenMaterial = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
};

function providerDisplayName(provider: string): string {
  return provider === 'anthropic' ? 'Claude' : 'Codex/OpenAI';
}

function isAnthropicOauthAccessToken(accessToken: string): boolean {
  return accessToken.includes('sk-ant-oat');
}

function resolvePreflightExpiresAt(provider: string, accessToken: string): Date {
  if ((provider === 'openai' || provider === 'codex') && isOpenAiOauthAccessToken(accessToken)) {
    return resolveOpenAiOauthExpiresAt(accessToken) ?? FAR_FUTURE_EXPIRY;
  }
  return FAR_FUTURE_EXPIRY;
}

function ensureOauthTokenShape(provider: string, accessToken: string): void {
  if (provider === 'anthropic') {
    if (!isAnthropicOauthAccessToken(accessToken)) {
      throw new AppError('invalid_request', 400, 'Claude OAuth token is not valid.');
    }
    return;
  }

  if (provider === 'openai' || provider === 'codex') {
    if (!isOpenAiOauthAccessToken(accessToken)) {
      throw new AppError('invalid_request', 400, 'Codex/OpenAI OAuth token is not valid.');
    }
    return;
  }

  throw new AppError('invalid_request', 400, `Unsupported provider for OAuth token validation: ${provider}`);
}

function buildTransientCredential(input: {
  provider: string;
  accessToken: string;
  refreshToken: string;
}): TokenCredential {
  const now = new Date();
  return {
    id: 'preflight',
    orgId: 'preflight',
    provider: input.provider,
    authScheme: 'bearer',
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: resolvePreflightExpiresAt(input.provider, input.accessToken),
    status: 'active',
    rotationVersion: 1,
    createdAt: now,
    updatedAt: now,
    revokedAt: null,
    monthlyContributionLimitUnits: null,
    monthlyContributionUsedUnits: 0,
    monthlyWindowStartAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    fiveHourReservePercent: 0,
    sevenDayReservePercent: 0,
    debugLabel: 'preflight',
    consecutiveFailureCount: 0,
    consecutiveRateLimitCount: 0,
    lastFailedStatus: null,
    lastFailedAt: null,
    lastRateLimitedAt: null,
    maxedAt: null,
    rateLimitedUntil: null,
    nextProbeAt: null,
    lastProbeAt: null
  };
}

function formatProbeFailureMessage(provider: string, outcome: TokenCredentialProbeOutcome): string {
  const label = providerDisplayName(provider);
  if (outcome.authValid === true && outcome.usageExhausted) {
    const windowLabel = outcome.usageExhaustedWindow && outcome.usageExhaustedWindow !== 'unknown'
      ? ` for the ${outcome.usageExhaustedWindow} window`
      : '';
    const resetLabel = outcome.usageResetAt ? ` Reset at ${outcome.usageResetAt.toISOString()}.` : '';
    return `${label} OAuth token is valid but currently exhausted${windowLabel}.${resetLabel}`.trim();
  }

  if (outcome.authValid === false || outcome.statusCode === 401 || outcome.statusCode === 403) {
    return `${label} OAuth token is not valid.`;
  }

  if (outcome.reason === 'invalid_payload') {
    return `Could not validate ${label} OAuth token: upstream returned an invalid probe payload.`;
  }

  if (outcome.reason.startsWith('network:')) {
    const reason = outcome.reason.slice('network:'.length) || 'network error';
    return `Could not validate ${label} OAuth token: ${reason}.`;
  }

  return `Could not validate ${label} OAuth token (${outcome.reason}${outcome.statusCode !== null ? `, upstream ${outcome.statusCode}` : ''}).`;
}

export async function preflightValidateTokenMaterial(input: {
  provider: string;
  accessToken: string;
  refreshToken: string;
}): Promise<ValidatedTokenMaterial> {
  const provider = input.provider.trim().toLowerCase();
  const accessToken = input.accessToken.trim();
  const refreshToken = input.refreshToken.trim();

  ensureOauthTokenShape(provider, accessToken);

  let current = buildTransientCredential({
    provider,
    accessToken,
    refreshToken
  });

  const repo = {
    async reactivateFromMaxed() {
      return false;
    },
    async markProbeFailure() {
      return true;
    },
    async refreshInPlace(update: {
      id: string;
      accessToken: string;
      refreshToken: string | null;
      expiresAt: Date | null;
      preserveStatus?: boolean;
    }) {
      current = {
        ...current,
        accessToken: update.accessToken,
        refreshToken: update.refreshToken ?? current.refreshToken,
        expiresAt: update.expiresAt ?? current.expiresAt,
        status: update.preserveStatus ? current.status : 'active',
        updatedAt: new Date()
      };
      return current;
    }
  };

  const outcome = await probeAndUpdateTokenCredential(repo as any, current, {
    timeoutMs: readTokenCredentialProbeTimeoutMs(),
    probeIntervalMinutes: readTokenCredentialProbeIntervalMinutes()
  });

  if (!outcome.ok) {
    throw new AppError(
      'invalid_request',
      400,
      formatProbeFailureMessage(provider, outcome),
      {
        provider,
        reason: outcome.reason,
        statusCode: outcome.statusCode,
        authValid: outcome.authValid,
        availabilityOk: outcome.availabilityOk,
        usageExhausted: outcome.usageExhausted,
        usageExhaustedWindow: outcome.usageExhaustedWindow,
        usageResetAt: outcome.usageResetAt ? outcome.usageResetAt.toISOString() : null,
        refreshAttempted: outcome.refreshAttempted,
        refreshSucceeded: outcome.refreshSucceeded,
        refreshReason: outcome.refreshReason
      }
    );
  }

  return {
    accessToken: current.accessToken,
    refreshToken: current.refreshToken ?? refreshToken,
    expiresAt: current.expiresAt
  };
}
