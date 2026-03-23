import {
  readPilotApiBaseUrl,
  readPilotUiBaseUrl
} from './pilotUrlConfig.js';

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

function readPilotSessionCookieDomain(): string | null {
  return sharedDomainSuffix(
    readHostname(readPilotUiBaseUrl()),
    readHostname(readPilotApiBaseUrl())
  );
}

function shouldUseSecureCookies(): boolean {
  return [readPilotUiBaseUrl(), readPilotApiBaseUrl()]
    .some((value) => readProtocol(value) === 'https:');
}

export function buildPilotUiRedirectUrl(returnTo: string | null | undefined): string {
  const normalized = returnTo?.trim();
  const safeReturnTo = normalized
    && normalized.startsWith('/')
    && !normalized.startsWith('//')
    && !normalized.includes('\\')
    ? normalized
    : '/pilot';
  return new URL(safeReturnTo, `${readPilotUiBaseUrl()}/`).toString();
}

export function buildPilotSessionCookie(token: string): string {
  const parts = [
    `innies_pilot_session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];
  const domain = readPilotSessionCookieDomain();
  if (domain) {
    parts.push(`Domain=${domain}`);
  }
  if (shouldUseSecureCookies()) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function buildClearedPilotSessionCookie(): string {
  const parts = [
    'innies_pilot_session=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];
  const domain = readPilotSessionCookieDomain();
  if (domain) {
    parts.push(`Domain=${domain}`);
  }
  if (shouldUseSecureCookies()) {
    parts.push('Secure');
  }
  return parts.join('; ');
}
