const MAX_ORG_SLUG_LENGTH = 48;

export function deriveOrgSlugPreview(name: string): string | null {
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

  return normalized.length > 0 ? normalized : null;
}
