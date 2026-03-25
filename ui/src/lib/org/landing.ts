const CREATE_ORG_QUERY_PARAM = 'createOrg';

function readQueryStringValue(value: string | string[] | undefined): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0].trim();
  }
  return '';
}

export function readPendingOrgName(searchParams: Record<string, string | string[] | undefined>): string {
  return readQueryStringValue(searchParams[CREATE_ORG_QUERY_PARAM]);
}

export function buildLandingOrgCreateReturnTo(orgName: string): string {
  const normalizedOrgName = orgName.trim();
  if (!normalizedOrgName) {
    return '/';
  }

  const params = new URLSearchParams();
  params.set(CREATE_ORG_QUERY_PARAM, normalizedOrgName);
  return `/?${params.toString()}`;
}

export function buildOrgCreationAuthStartUrl(authStartUrl: string, orgName: string): string {
  const url = new URL(authStartUrl);
  url.searchParams.set('returnTo', buildLandingOrgCreateReturnTo(orgName));
  return url.toString();
}
