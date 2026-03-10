import { NextResponse } from 'next/server';

type HeaderReader = {
  get(name: string): string | null;
};

type AnalyticsAccessConfig = {
  username: string;
  password: string;
  realm: string;
};

type AnalyticsAccessFailure = {
  code: 'analytics_access_misconfigured' | 'unauthorized';
  message: string;
  status: 401 | 503;
};

const DEFAULT_REALM = 'Innies Analytics';

function normalizeHostname(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return null;

  if (trimmed.startsWith('[')) {
    const endBracket = trimmed.indexOf(']');
    return endBracket >= 0 ? trimmed.slice(1, endBracket) : trimmed;
  }

  const colonIndex = trimmed.indexOf(':');
  return colonIndex >= 0 ? trimmed.slice(0, colonIndex) : trimmed;
}

function isLocalRequest(headers: HeaderReader): boolean {
  const hostname = normalizeHostname(headers.get('x-forwarded-host') ?? headers.get('host'));
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1';
}

function readAnalyticsAccessConfig(): AnalyticsAccessConfig | null {
  const username = process.env.INNIES_ANALYTICS_BASIC_AUTH_USERNAME?.trim();
  const password = process.env.INNIES_ANALYTICS_BASIC_AUTH_PASSWORD?.trim();

  if (!username || !password) return null;

  return {
    username,
    password,
    realm: process.env.INNIES_ANALYTICS_BASIC_AUTH_REALM?.trim() || DEFAULT_REALM,
  };
}

function parseBasicAuthorization(value: string | null): { username: string; password: string } | null {
  if (!value) return null;

  const [scheme, token] = value.split(' ', 2);
  if (!scheme || !token || scheme.toLowerCase() !== 'basic') return null;

  try {
    const decoded = atob(token);
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex < 0) return null;

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
}

export function shouldShowAnalyticsIndexLink(): boolean {
  return process.env.INNIES_ANALYTICS_SHOW_INDEX_LINK?.trim().toLowerCase() === 'true';
}

export function getAnalyticsAccessFailure(headers: HeaderReader): AnalyticsAccessFailure | null {
  if (process.env.NODE_ENV !== 'production' || isLocalRequest(headers)) {
    return null;
  }

  const config = readAnalyticsAccessConfig();
  if (!config) {
    return {
      code: 'analytics_access_misconfigured',
      message: 'Missing INNIES_ANALYTICS_BASIC_AUTH_USERNAME or INNIES_ANALYTICS_BASIC_AUTH_PASSWORD',
      status: 503,
    };
  }

  const credentials = parseBasicAuthorization(headers.get('authorization'));
  if (!credentials) {
    return {
      code: 'unauthorized',
      message: 'Analytics access requires authentication',
      status: 401,
    };
  }

  if (credentials.username !== config.username || credentials.password !== config.password) {
    return {
      code: 'unauthorized',
      message: 'Analytics access requires authentication',
      status: 401,
    };
  }

  return null;
}

export function createAnalyticsPageAccessResponse(failure: AnalyticsAccessFailure): Response {
  const config = readAnalyticsAccessConfig();
  return new Response(failure.message, {
    status: failure.status,
    headers: {
      'cache-control': 'no-store',
      ...(failure.status === 401
        ? { 'www-authenticate': `Basic realm="${config?.realm || DEFAULT_REALM}", charset="UTF-8"` }
        : {}),
    },
  });
}

export function createAnalyticsApiAccessResponse(failure: AnalyticsAccessFailure) {
  const config = readAnalyticsAccessConfig();
  return NextResponse.json(
    {
      code: failure.code,
      message: failure.message,
    },
    {
      status: failure.status,
      headers: {
        'cache-control': 'no-store',
        ...(failure.status === 401
          ? { 'www-authenticate': `Basic realm="${config?.realm || DEFAULT_REALM}", charset="UTF-8"` }
          : {}),
      },
    },
  );
}
