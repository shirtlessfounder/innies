import { getPathSegments, proxyJsonRequest } from '../../../_helpers.js';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const orgSlug = getPathSegments(request)[2] ?? '';
  return proxyJsonRequest(request, {
    path: `/v1/orgs/${encodeURIComponent(orgSlug)}/analytics/timeseries`,
    method: 'GET',
    forwardSearch: true,
  });
}
