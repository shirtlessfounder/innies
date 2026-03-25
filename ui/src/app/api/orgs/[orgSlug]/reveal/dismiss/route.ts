import { expireCookieHeader, getPathSegments } from '../../../_helpers.js';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const orgSlug = getPathSegments(request)[2] ?? '';

  return new Response(null, {
    status: 303,
    headers: {
      'cache-control': 'no-store',
      location: new URL(`/${orgSlug}`, request.url).toString(),
      'set-cookie': expireCookieHeader('innies_org_reveal', request.url, `/${orgSlug}`),
    },
  });
}
