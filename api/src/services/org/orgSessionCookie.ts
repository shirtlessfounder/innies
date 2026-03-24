import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from 'node:crypto';
import {
  readPilotApiBaseUrl,
  readPilotUiBaseUrl
} from '../pilot/pilotUrlConfig.js';

export const ORG_SESSION_COOKIE_NAME = 'innies_org_session';
export const ORG_REVEAL_COOKIE_NAME = 'innies_org_reveal';

type OrgRevealReason = 'org_created' | 'invite_accepted';

type OrgRevealPayload = {
  buyerKey: string;
  orgSlug: string;
  reason: OrgRevealReason;
};

const REVEAL_ALGORITHM = 'aes-256-gcm';
const REVEAL_IV_BYTES = 12;

function readBaseUrl(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  try {
    return new URL(normalized).origin;
  } catch {
    return null;
  }
}

function readHostname(value: string | null | undefined): string | null {
  const baseUrl = readBaseUrl(value);
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function readProtocol(value: string | null | undefined): string | null {
  const baseUrl = readBaseUrl(value);
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).protocol;
  } catch {
    return null;
  }
}

function sharedDomainSuffix(leftHost: string | null, rightHost: string | null): string | null {
  if (!leftHost || !rightHost) return null;

  const leftLabels = leftHost.split('.').filter(Boolean);
  const rightLabels = rightHost.split('.').filter(Boolean);
  const shared: string[] = [];

  while (
    shared.length < leftLabels.length
    && shared.length < rightLabels.length
    && leftLabels[leftLabels.length - 1 - shared.length] === rightLabels[rightLabels.length - 1 - shared.length]
  ) {
    shared.unshift(leftLabels[leftLabels.length - 1 - shared.length]);
  }

  if (shared.length < 2) return null;
  const suffix = shared.join('.');

  if (/^\d+\.\d+\.\d+\.\d+$/.test(suffix) || suffix.includes(':')) {
    return null;
  }

  return suffix;
}

function readOrgCookieDomain(): string | null {
  return sharedDomainSuffix(
    readHostname(readPilotUiBaseUrl()),
    readHostname(readPilotApiBaseUrl())
  );
}

function shouldUseSecureCookies(): boolean {
  return [readPilotUiBaseUrl(), readPilotApiBaseUrl()]
    .some((value) => readProtocol(value) === 'https:');
}

function deriveRevealKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

function encodeBase64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function readSessionCookieToken(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const entry of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = entry.trim().split('=');
    if (rawName === ORG_SESSION_COOKIE_NAME) {
      return rawValue.join('=').trim() || null;
    }
  }
  return null;
}

function readRevealCookieToken(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const entry of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = entry.trim().split('=');
    if (rawName === ORG_REVEAL_COOKIE_NAME) {
      return rawValue.join('=').trim() || null;
    }
  }
  return null;
}

function encryptRevealPayload(payload: OrgRevealPayload): string {
  const iv = randomBytes(REVEAL_IV_BYTES);
  const cipher = createCipheriv(
    REVEAL_ALGORITHM,
    deriveRevealKey(process.env.ORG_REVEAL_SECRET || 'dev-insecure-org-reveal-secret'),
    iv
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return ['v1', encodeBase64Url(iv), encodeBase64Url(tag), encodeBase64Url(ciphertext)].join('.');
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
      decodeBase64Url(rawIv)
    );
    decipher.setAuthTag(decodeBase64Url(rawTag));
    const plaintext = Buffer.concat([
      decipher.update(decodeBase64Url(rawCiphertext)),
      decipher.final()
    ]).toString('utf8');
    const parsed = JSON.parse(plaintext) as Partial<OrgRevealPayload>;
    if (
      typeof parsed?.orgSlug !== 'string'
      || typeof parsed?.buyerKey !== 'string'
      || (parsed?.reason !== 'org_created' && parsed?.reason !== 'invite_accepted')
    ) {
      return null;
    }
    return parsed as OrgRevealPayload;
  } catch {
    return null;
  }
}

function buildCookieParts(name: string, value: string, path: string): string[] {
  const parts = [
    `${name}=${value}`,
    `Path=${path}`,
    'HttpOnly',
    'SameSite=Lax'
  ];
  const domain = readOrgCookieDomain();
  if (domain) {
    parts.push(`Domain=${domain}`);
  }
  if (shouldUseSecureCookies()) {
    parts.push('Secure');
  }
  return parts;
}

export function buildOrgSessionCookie(token: string): string {
  return buildCookieParts(ORG_SESSION_COOKIE_NAME, token, '/').join('; ');
}

export function buildClearOrgSessionCookie(): string {
  return [...buildCookieParts(ORG_SESSION_COOKIE_NAME, '', '/'), 'Max-Age=0'].join('; ');
}

export function readOrgSessionTokenFromRequest(req: {
  header(name: string): string | undefined;
}): string | null {
  const auth = req.header('authorization');
  if (auth) {
    const match = auth.match(/^\s*bearer\s+(.+)\s*$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return readSessionCookieToken(req.header('cookie'));
}

export function buildOrgRevealCookie(input: {
  orgSlug: string;
  buyerKey: string;
  reason: OrgRevealReason;
}): string {
  const token = encryptRevealPayload({
    orgSlug: input.orgSlug,
    buyerKey: input.buyerKey,
    reason: input.reason
  });
  return [...buildCookieParts(ORG_REVEAL_COOKIE_NAME, token, `/${input.orgSlug}`), 'Max-Age=600'].join('; ');
}

export function readOrgRevealCookie(input: {
  orgSlug: string;
  cookieHeader: string | null;
}): { buyerKey: string; reason: OrgRevealReason } | null {
  const token = readRevealCookieToken(input.cookieHeader);
  if (!token) return null;
  const payload = decryptRevealPayload(token);
  if (!payload || payload.orgSlug !== input.orgSlug) {
    return null;
  }
  return {
    buyerKey: payload.buyerKey,
    reason: payload.reason
  };
}

export function buildClearOrgRevealCookie(orgSlug: string): string {
  return [...buildCookieParts(ORG_REVEAL_COOKIE_NAME, '', `/${orgSlug}`), 'Max-Age=0'].join('; ');
}
