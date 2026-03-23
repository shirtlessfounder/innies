function normalizeUrl(value: string | null | undefined): URL | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

export function resolvePilotSessionCookieDomain(
  uiUrl: string,
  apiBaseUrl: string | null | undefined
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

export function pilotSessionCookieOptions(requestUrl: string, input?: { maxAge?: number }) {
  const domain = resolvePilotSessionCookieDomain(
    requestUrl,
    process.env.INNIES_API_BASE_URL?.trim() || process.env.INNIES_BASE_URL?.trim() || null
  );
  const isSecure = normalizeUrl(requestUrl)?.protocol === 'https:';

  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    ...(domain ? { domain } : {}),
    ...(isSecure ? { secure: true } : {}),
    ...(input?.maxAge === undefined ? {} : { maxAge: input.maxAge })
  };
}
