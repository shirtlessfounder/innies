import { getPathSegments, proxyJsonRequest } from '../../../../_helpers.js';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const segments = getPathSegments(request);
  const orgSlug = segments[2] ?? '';
  const memberUserId = segments[4] ?? '';

  return proxyJsonRequest(request, {
    path: `/v1/orgs/${encodeURIComponent(orgSlug)}/members/${encodeURIComponent(memberUserId)}/remove`,
    method: 'POST',
  });
}
