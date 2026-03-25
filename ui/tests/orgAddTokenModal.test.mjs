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

test('org add-token modal uses the smaller width cap and constrains reserve inputs to 100%', () => {
  const stylesSource = readSource('src/app/analytics/page.module.css');
  const toolbarSource = readSource('src/components/org/OrgDashboardToolbarActions.tsx');
  const modalInputOverride = stylesSource.match(/\.modalFormStack\s+\.managementInput,\s*\n\.modalFormStack\s+\.managementSelect\s*\{([^}]*)\}/)?.[1] ?? '';

  assert.ok(stylesSource.includes('.modalCard'));
  assert.ok(stylesSource.includes('width: min(410px, 100%);'));
  assert.ok(!stylesSource.includes('width: min(614px, 100%);'));
  assert.ok(modalInputOverride.includes('border-radius: 8px;'));
  assert.ok(toolbarSource.includes('name="fiveHourReservePercent"'));
  assert.ok(toolbarSource.includes('name="sevenDayReservePercent"'));
  assert.ok(toolbarSource.includes('name="refreshToken"'));
  assert.ok(toolbarSource.includes('Refresh token *'));
  assert.ok(toolbarSource.includes('name="refreshToken" placeholder="Paste refresh token" required type="password"'));
  assert.equal((toolbarSource.match(/max=\{100\}/g) ?? []).length >= 2, true);
  assert.ok(!toolbarSource.includes('Add Claude and Codex tokens to this org. Tokens can only be added to one org at a time.'));
  assert.ok(toolbarSource.includes('Click here for guide to obtain tokens.'));
});
