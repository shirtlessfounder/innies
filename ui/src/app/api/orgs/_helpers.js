function normalizeUrl(value) {
  const normalized = value?.trim();
  if (!normalized) return null;

  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

function readApiBaseUrl() {
  const baseUrl = process.env.INNIES_API_BASE_URL?.trim()
    || process.env.INNIES_BASE_URL?.trim()
    || '';
  if (!baseUrl) {
    throw new Error('Missing INNIES_API_BASE_URL');
  }
  return baseUrl.replace(/\/+$/, '');
}

export function getPathSegments(request) {
  return new URL(request.url).pathname.split('/').filter(Boolean);
}

export function resolveSharedCookieDomain(requestUrl, apiBaseUrl) {
  const uiHost = normalizeUrl(requestUrl)?.hostname.toLowerCase() ?? null;
  const apiHost = normalizeUrl(apiBaseUrl)?.hostname.toLowerCase() ?? null;
  if (!uiHost || !apiHost) return null;

  const uiLabels = uiHost.split('.').filter(Boolean);
  const apiLabels = apiHost.split('.').filter(Boolean);
  const shared = [];

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

export function expireCookieHeader(name, requestUrl, path) {
  const apiBaseUrl = process.env.INNIES_API_BASE_URL?.trim()
    || process.env.INNIES_BASE_URL?.trim()
    || null;
  const domain = resolveSharedCookieDomain(requestUrl, apiBaseUrl);
  const isSecure = normalizeUrl(requestUrl)?.protocol === 'https:';
  const parts = [
    `${name}=`,
    `Path=${path}`,
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ];

  if (domain) parts.push(`Domain=${domain}`);
  if (isSecure) parts.push('Secure');

  return parts.join('; ');
}

async function toProxyResponse(upstream, options) {
  const bodyText = await upstream.text();
  const headers = new Headers();
  headers.set('cache-control', 'no-store');

  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);

  if (options?.forwardSetCookie) {
    const setCookie = upstream.headers.get('set-cookie');
    if (setCookie) headers.set('set-cookie', setCookie);
  }

  return new Response(bodyText.length > 0 ? bodyText : null, {
    status: upstream.status,
    headers,
  });
}

export async function proxyJsonRequest(request, options) {
  const requestUrl = new URL(request.url);
  const upstream = new URL(options.path, `${readApiBaseUrl()}/`);
  if (options.forwardSearch) {
    upstream.search = requestUrl.search;
  }

  const bodyText = request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : await request.text();
  const contentType = request.headers.get('content-type');
  const cookieHeader = request.headers.get('cookie');

  const upstreamResponse = await fetch(upstream, {
    method: options.method ?? request.method,
    headers: {
      accept: 'application/json',
      ...(contentType ? { 'content-type': contentType } : {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    ...(bodyText && bodyText.length > 0 ? { body: bodyText } : {}),
    cache: 'no-store',
  });

  return toProxyResponse(upstreamResponse, options);
}
