import {
  expireCookieHeader,
  getPathSegments,
} from '../../../_helpers.js';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const orgSlug = getPathSegments(request)[2] ?? '';
  const apiBaseUrl = process.env.INNIES_API_BASE_URL?.trim()
    || process.env.INNIES_BASE_URL?.trim()
    || '';
  if (!apiBaseUrl) {
    throw new Error('Missing INNIES_API_BASE_URL');
  }
  const upstream = new URL(
    `/v1/orgs/${encodeURIComponent(orgSlug)}/buyer-key/provider-preference`,
    `${apiBaseUrl.replace(/\/+$/, '')}/`,
  );
  const bodyText = await request.text();
  const contentType = request.headers.get('content-type');
  const cookieHeader = request.headers.get('cookie');

  const upstreamResponse = await fetch(upstream, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      ...(contentType ? { 'content-type': contentType } : {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    ...(bodyText.length > 0 ? { body: bodyText } : {}),
    cache: 'no-store',
  });

  const responseText = await upstreamResponse.text();
  const headers = new Headers({
    'cache-control': 'no-store',
  });
  const upstreamContentType = upstreamResponse.headers.get('content-type');
  if (upstreamContentType) {
    headers.set('content-type', upstreamContentType);
  }
  if (upstreamResponse.ok) {
    headers.set('set-cookie', expireCookieHeader('innies_org_reveal', request.url, `/${orgSlug}`));
  }

  return new Response(responseText.length > 0 ? responseText : null, {
    status: upstreamResponse.status,
    headers,
  });
}
