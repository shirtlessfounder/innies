const INTERNAL_ORG_ROUTE_SLUG = 'innies';
const LEGACY_INTERNAL_ORG_SLUG = 'team-seller';

type OrgSummary = {
  id: string;
  slug: string;
  name: string;
  ownerUserId: string;
};

type FindOrgBySlug = (slug: string) => Promise<OrgSummary | null>;

function normalizeRouteSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

function toRouteOrgSummary(routeSlug: string, org: OrgSummary): OrgSummary {
  return {
    ...org,
    slug: routeSlug
  };
}

export async function resolveOrgRouteSlug(input: {
  routeSlug: string;
  findOrgBySlug: FindOrgBySlug;
}): Promise<{
  routeSlug: string;
  effectiveOrgSlug: string;
  org: OrgSummary;
} | null> {
  const routeSlug = normalizeRouteSlug(input.routeSlug);
  const directOrg = await input.findOrgBySlug(routeSlug);
  if (directOrg) {
    return {
      routeSlug,
      effectiveOrgSlug: directOrg.slug,
      org: toRouteOrgSummary(routeSlug, directOrg)
    };
  }

  if (routeSlug !== INTERNAL_ORG_ROUTE_SLUG) {
    return null;
  }

  const legacyOrg = await input.findOrgBySlug(LEGACY_INTERNAL_ORG_SLUG);
  if (!legacyOrg) {
    return null;
  }

  return {
    routeSlug,
    effectiveOrgSlug: legacyOrg.slug,
    org: toRouteOrgSummary(routeSlug, legacyOrg)
  };
}
