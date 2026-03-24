const MAX_ORG_SLUG_LENGTH = 48;
const RESERVED_ORG_SLUGS = new Set([
  'admin',
  'analytics',
  'api',
  'innies',
  'onboard',
  'pilot'
]);

export function normalizeOrgSlug(name: string): string {
  const normalized = name
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ORG_SLUG_LENGTH)
    .replace(/-+$/g, '');

  if (!normalized) {
    throw new Error('Org slug cannot be empty');
  }

  return normalized;
}

export function assertOrgSlugAllowed(slug: string): void {
  if (!slug) {
    throw new Error('Org slug cannot be empty');
  }
  if (slug.length > MAX_ORG_SLUG_LENGTH) {
    throw new Error('Org slug exceeds max length');
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error('Org slug must contain only lowercase letters, numbers, and single dashes');
  }
  if (RESERVED_ORG_SLUGS.has(slug)) {
    throw new Error('Org slug is reserved');
  }
}
