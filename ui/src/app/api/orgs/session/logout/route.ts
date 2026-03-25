import { expireCookieHeader } from '../../_helpers.js';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return new Response(null, {
    status: 303,
    headers: {
      'cache-control': 'no-store',
      location: new URL('/', request.url).toString(),
      'set-cookie': expireCookieHeader('innies_org_session', request.url, '/'),
    },
  });
}
