export function normalizePilotReturnTo(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (!normalized.startsWith('/')) return null;
  if (normalized.startsWith('//')) return null;
  if (normalized.includes('\\')) return null;
  return normalized;
}
