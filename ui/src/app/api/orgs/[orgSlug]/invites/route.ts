import { getPathSegments, proxyJsonRequest } from '../../_helpers.js';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const orgSlug = getPathSegments(request)[2] ?? '';
  return proxyJsonRequest(request, {
    path: `/v1/orgs/${encodeURIComponent(orgSlug)}/invites`,
    method: 'POST',
  });
}
