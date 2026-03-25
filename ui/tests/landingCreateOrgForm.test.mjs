import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiRoot = join(__dirname, '..');

function readSource(relativePath) {
  return readFileSync(join(uiRoot, relativePath), 'utf8');
}

test('landing create-org CTA stays disabled until the org name yields a valid slug and uses a grab cursor when enabled', () => {
  const formSource = readSource('src/components/org/OrgCreationForm.tsx');
  const stylesSource = readSource('src/app/page.module.css');
  const heroFormBlock = stylesSource.match(/\.heroForm\s*\{([^}]*)\}/)?.[1] ?? '';
  const heroInputBlock = stylesSource.match(/\.heroInput\s*\{([^}]*)\}/)?.[1] ?? '';
  const primaryCtaBlock = stylesSource.match(/\.primaryCta\s*\{\s*position:\s*relative;([^}]*)\}/)?.[1] ?? '';

  assert.ok(formSource.includes('const slugPreview = deriveOrgSlugPreview(orgName);'));
  assert.ok(formSource.includes('disabled={pending || slugPreview === null}'));
  assert.ok(heroFormBlock.includes('width: calc(var(--hero-frame-width) * 0.76);'));
  assert.ok(heroFormBlock.includes('min-width: 228px;'));
  assert.ok(heroInputBlock.includes('box-sizing: border-box;'));
  assert.ok(heroInputBlock.includes('height: 48px;'));
  assert.ok(heroInputBlock.includes('min-height: 48px;'));
  assert.ok(heroInputBlock.includes('padding: 0 18px;'));
  assert.ok(heroInputBlock.includes('border-radius: 8px;'));
  assert.ok(heroInputBlock.includes("font-family: 'SFMono-Regular'"));
  assert.ok(heroInputBlock.includes('font-size: 0.92rem;'));
  assert.ok(heroInputBlock.includes('font-weight: 500;'));
  assert.ok(heroInputBlock.includes('letter-spacing: 0.16em;'));
  assert.ok(primaryCtaBlock.includes('box-sizing: border-box;'));
  assert.ok(primaryCtaBlock.includes('height: 48px;'));
  assert.ok(primaryCtaBlock.includes('min-height: 48px;'));
  assert.ok(stylesSource.includes('.primaryCta:not(:disabled):hover'));
  assert.ok(stylesSource.includes('cursor: grab;'));
  assert.ok(stylesSource.includes('.primaryCta:not(:disabled):active'));
  assert.ok(stylesSource.includes('cursor: grabbing;'));
  assert.ok(stylesSource.includes('.primaryCta:disabled'));
  assert.ok(stylesSource.includes('cursor: not-allowed;'));
});
