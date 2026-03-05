type JwtPayload = Record<string, unknown>;

export type OpenAiOauthAccessTokenMeta = {
  issuer: string;
  clientId: string | null;
  accountId: string | null;
  expiresAt: Date | null;
};

function decodeBase64UrlSegment(segment: string): string | null {
  const normalized = segment
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padding = normalized.length % 4;
  const padded = padding === 0
    ? normalized
    : `${normalized}${'='.repeat(4 - padding)}`;

  try {
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.trim().split('.');
  if (parts.length !== 3) return null;

  const payloadJson = decodeBase64UrlSegment(parts[1]);
  if (!payloadJson) return null;

  try {
    const parsed = JSON.parse(payloadJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as JwtPayload;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function readAudience(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .map(readString)
    .filter((entry): entry is string => Boolean(entry));
}

function readAuthClaim(payload: JwtPayload): Record<string, unknown> | null {
  const claim = payload['https://api.openai.com/auth'];
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return null;
  return claim as Record<string, unknown>;
}

export function parseOpenAiOauthAccessToken(accessToken: string): OpenAiOauthAccessTokenMeta | null {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return null;

  const issuer = readString(payload.iss);
  if (issuer !== 'https://auth.openai.com') return null;

  const authClaim = readAuthClaim(payload);
  const clientId = readString(payload.client_id);
  const accountId = readString(authClaim?.chatgpt_account_id) ?? readString(payload.chatgpt_account_id);
  const audience = readAudience(payload.aud);
  const hasOpenAiAudience = audience.some((entry) => entry.includes('api.openai.com'));

  if (!clientId && !accountId && !hasOpenAiAudience) return null;

  const exp = typeof payload.exp === 'number' && Number.isFinite(payload.exp)
    ? new Date(payload.exp * 1000)
    : null;

  return {
    issuer,
    clientId,
    accountId,
    expiresAt: exp
  };
}

export function isOpenAiOauthAccessToken(accessToken: string): boolean {
  return parseOpenAiOauthAccessToken(accessToken) !== null;
}

export function resolveOpenAiOauthAccountId(accessToken: string): string | null {
  return parseOpenAiOauthAccessToken(accessToken)?.accountId ?? null;
}

export function resolveOpenAiOauthClientId(accessToken: string): string | null {
  return parseOpenAiOauthAccessToken(accessToken)?.clientId ?? null;
}

export function resolveOpenAiOauthExpiresAt(accessToken: string): Date | null {
  return parseOpenAiOauthAccessToken(accessToken)?.expiresAt ?? null;
}
