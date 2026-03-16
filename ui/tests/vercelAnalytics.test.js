const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const rootDir = join(__dirname, '..');

test('ui package includes Vercel Web Analytics dependency', () => {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies?.['@vercel/analytics'], 'expected @vercel/analytics dependency');
});

test('root layout mounts Vercel Web Analytics once', () => {
  const layout = readFileSync(join(rootDir, 'src/app/layout.tsx'), 'utf8');

  assert.match(layout, /import\s+\{\s*Analytics\s*\}\s+from\s+['"]@vercel\/analytics\/next['"];/);
  assert.match(layout, /<Analytics\s*\/>/);
});
