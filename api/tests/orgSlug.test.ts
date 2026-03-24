import { describe, expect, it } from 'vitest';
import { assertOrgSlugAllowed, normalizeOrgSlug } from '../src/services/org/orgSlug.js';

describe('orgSlug', () => {
  it('normalizes names into deterministic ASCII slugs', () => {
    expect(normalizeOrgSlug('  Cafe deja vu  ')).toBe('cafe-deja-vu');
    expect(normalizeOrgSlug('Caf\u00e9 D\u00e9j\u00e0 Vu')).toBe('cafe-deja-vu');
    expect(normalizeOrgSlug('Hello___World!!!')).toBe('hello-world');
  });

  it('collapses separators, trims edges, and enforces the 48 character limit', () => {
    expect(normalizeOrgSlug('--- Launch   Team ---')).toBe('launch-team');
    expect(normalizeOrgSlug('A'.repeat(60))).toBe('a'.repeat(48));
  });

  it('rejects empty slugs after normalization', () => {
    expect(() => normalizeOrgSlug('   !!!   ')).toThrow(/slug/i);
  });

  it('rejects reserved slugs', () => {
    expect(() => assertOrgSlugAllowed('innies')).toThrow(/reserved/i);
    expect(() => assertOrgSlugAllowed('analytics')).toThrow(/reserved/i);
  });

  it('allows normalized non-reserved slugs', () => {
    expect(() => assertOrgSlugAllowed('launch-team')).not.toThrow();
  });
});
