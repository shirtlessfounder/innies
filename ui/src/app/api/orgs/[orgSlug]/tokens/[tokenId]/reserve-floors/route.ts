import { getPathSegments, proxyJsonRequest } from '../../../../_helpers.js';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const segments = getPathSegments(request);
  const orgSlug = segments[2] ?? '';
  const tokenId = segments[4] ?? '';

  return proxyJsonRequest(request, {
    path: `/v1/orgs/${encodeURIComponent(orgSlug)}/tokens/${encodeURIComponent(tokenId)}/reserve-floors`,
    method: 'POST',
  });
}
