import { proxyJsonRequest } from '../_helpers.js';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return proxyJsonRequest(request, {
    path: '/v1/orgs',
    method: 'POST',
    forwardSetCookie: true,
  });
}
