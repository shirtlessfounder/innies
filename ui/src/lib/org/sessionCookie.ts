import {
  createDecipheriv,
  createHash,
} from 'node:crypto';

export const ORG_SESSION_COOKIE_NAME = 'innies_org_session';
export const ORG_REVEAL_COOKIE_NAME = 'innies_org_reveal';

type OrgRevealPayload = {
  buyerKey: string;
  orgSlug: string;
  reason: 'org_created' | 'invite_accepted';
};

const REVEAL_ALGORITHM = 'aes-256-gcm';

function normalizeUrl(value: string | null | undefined): URL | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

function normalizeOrgSlug(orgSlug: string): string {
  return orgSlug.trim().toLowerCase();
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function deriveRevealKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

function decryptRevealPayload(token: string): OrgRevealPayload | null {
  const [version, rawIv, rawTag, rawCiphertext] = token.split('.');
  if (version !== 'v1' || !rawIv || !rawTag || !rawCiphertext) {
    return null;
  }

  try {
    const decipher = createDecipheriv(
      REVEAL_ALGORITHM,
      deriveRevealKey(process.env.ORG_REVEAL_SECRET || 'dev-insecure-org-reveal-secret'),
      decodeBase64Url(rawIv),
    );
    decipher.setAuthTag(decodeBase64Url(rawTag));
    const plaintext = Buffer.concat([
      decipher.update(decodeBase64Url(rawCiphertext)),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(plaintext) as Partial<OrgRevealPayload>;
    if (
      typeof parsed?.buyerKey !== 'string'
      || typeof parsed?.orgSlug !== 'string'
      || (parsed?.reason !== 'org_created' && parsed?.reason !== 'invite_accepted')
    ) {
      return null;
    }
    return parsed as OrgRevealPayload;
  } catch {
    return null;
  }
}

export function resolveOrgSessionCookieDomain(
  uiUrl: string,
  apiBaseUrl: string | null | undefined,
): string | null {
  const uiHost = normalizeUrl(uiUrl)?.hostname.toLowerCase() ?? null;
  const apiHost = normalizeUrl(apiBaseUrl)?.hostname.toLowerCase() ?? null;
  if (!uiHost || !apiHost) return null;

  const uiLabels = uiHost.split('.').filter(Boolean);
  const apiLabels = apiHost.split('.').filter(Boolean);
  const shared: string[] = [];

  while (
    shared.length < uiLabels.length
    && shared.length < apiLabels.length
    && uiLabels[uiLabels.length - 1 - shared.length] === apiLabels[apiLabels.length - 1 - shared.length]
  ) {
    shared.unshift(uiLabels[uiLabels.length - 1 - shared.length]);
  }

  if (shared.length < 2) return null;
  const domain = shared.join('.');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(domain) || domain.includes(':')) {
    return null;
  }
  return domain;
}

export function orgSessionCookieOptions(requestUrl: string, input?: { maxAge?: number }) {
  const domain = resolveOrgSessionCookieDomain(
    requestUrl,
    process.env.INNIES_API_BASE_URL?.trim() || process.env.INNIES_BASE_URL?.trim() || null,
  );
  const isSecure = normalizeUrl(requestUrl)?.protocol === 'https:';

  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    ...(domain ? { domain } : {}),
    ...(isSecure ? { secure: true } : {}),
    ...(input?.maxAge === undefined ? {} : { maxAge: input.maxAge }),
  };
}

export function getOrgRevealCookiePath(orgSlug: string): string {
  return `/${normalizeOrgSlug(orgSlug)}`;
}

export async function readOrgRevealCookie(orgSlug: string): Promise<{
  buyerKey: string;
  reason: 'org_created' | 'invite_accepted';
} | null> {
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  const token = cookieStore.get(ORG_REVEAL_COOKIE_NAME)?.value ?? null;
  if (!token) return null;

  const payload = decryptRevealPayload(token);
  if (!payload || payload.orgSlug !== normalizeOrgSlug(orgSlug)) {
    return null;
  }

  return {
    buyerKey: payload.buyerKey,
    reason: payload.reason,
  };
}
