import { parseOpenAiOauthAccessToken } from '../utils/openaiOauth.js';

export type TokenCredentialAuthDiagnosis = {
  authDiagnosis: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenState: 'missing' | 'present' | null;
};

type TokenCredentialAuthDiagnosisInput = {
  provider: string;
  accessToken?: string | null;
  hasRefreshToken?: boolean | null;
  statusCode?: number | null;
  lastFailedStatus?: number | null;
  reason?: string | null;
  lastRefreshError?: string | null;
  now?: Date | string | null;
};

function parseOptionalDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function parseAuthStatusFromText(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  const statusMatch = normalized.match(/(?:^|[:_])(401|403)(?:$|[:_])/);
  if (!statusMatch) return null;
  const status = Number(statusMatch[1]);
  return status === 401 || status === 403 ? status : null;
}

function readAuthStatus(input: TokenCredentialAuthDiagnosisInput): number | null {
  const direct = input.statusCode ?? null;
  if (direct === 401 || direct === 403) return direct;

  const lastFailed = input.lastFailedStatus ?? null;
  if (lastFailed === 401 || lastFailed === 403) return lastFailed;

  return parseAuthStatusFromText(input.reason)
    ?? parseAuthStatusFromText(input.lastRefreshError);
}

export function deriveTokenCredentialAuthDiagnosis(
  input: TokenCredentialAuthDiagnosisInput
): TokenCredentialAuthDiagnosis {
  const now = parseOptionalDate(input.now) ?? new Date();
  const refreshTokenState = input.hasRefreshToken === true
    ? 'present'
    : input.hasRefreshToken === false
      ? 'missing'
      : null;

  let accessTokenExpiresAt: string | null = null;
  let authDiagnosis: string | null = null;

  const provider = input.provider.trim().toLowerCase();
  if ((provider === 'openai' || provider === 'codex') && typeof input.accessToken === 'string' && input.accessToken.trim().length > 0) {
    const parsed = parseOpenAiOauthAccessToken(input.accessToken);
    if (parsed?.expiresAt && !Number.isNaN(parsed.expiresAt.getTime())) {
      accessTokenExpiresAt = parsed.expiresAt.toISOString();
      if (parsed.expiresAt.getTime() <= now.getTime()) {
        authDiagnosis = 'access_token_expired_local';
      }
    }
  }

  if (authDiagnosis === null) {
    const authStatus = readAuthStatus(input);
    if (authStatus === 401 || authStatus === 403) {
      authDiagnosis = `upstream_status_${authStatus}`;
    }
  }

  return {
    authDiagnosis,
    accessTokenExpiresAt,
    refreshTokenState
  };
}
