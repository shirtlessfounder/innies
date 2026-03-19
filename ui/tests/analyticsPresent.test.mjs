import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  formatContributionCapPercent,
  formatCount,
  formatSummaryUnitsCompact,
} from '../src/lib/analytics/present.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiRoot = join(__dirname, '..');

test('formatSummaryUnitsCompact formats millions with 4 decimals and M suffix', () => {
  assert.equal(formatSummaryUnitsCompact(149_917_231), '149.9172M');
});

test('formatSummaryUnitsCompact formats billions with 4 decimals and B suffix', () => {
  assert.equal(formatSummaryUnitsCompact(1_234_567_890), '1.2346B');
});

test('formatSummaryUnitsCompact keeps values below one million unscaled', () => {
  assert.equal(formatSummaryUnitsCompact(999_999), formatCount(999_999));
});

test('formatSummaryUnitsCompact preserves nullish placeholder behavior', () => {
  assert.equal(formatSummaryUnitsCompact(null), '--');
  assert.equal(formatSummaryUnitsCompact(undefined), '--');
});

test('formatContributionCapPercent renders Codex usage ratios when present', () => {
  assert.equal(formatContributionCapPercent(0.41, 'openai'), '41.0%');
});

test('analytics token sort keeps non-Claude 5h and 7d ratios sortable', () => {
  const sortSource = readFileSync(join(uiRoot, 'src/lib/analytics/sort.ts'), 'utf8');

  assert.ok(!sortSource.includes("if (provider !== 'anthropic') return null;"));
  assert.ok(sortSource.includes("return key === 'fiveHourCapUsedRatio' ? row.fiveHourCapUsedRatio : row.sevenDayCapUsedRatio;"));
});

test('analytics server preserves non-Claude usage ratios for 5h and 7d cells', () => {
  const serverSource = readFileSync(join(uiRoot, 'src/lib/analytics/server.ts'), 'utf8');

  assert.ok(serverSource.includes('fiveHourCapUsedRatio: deriveContributionCapUsedRatio({'));
  assert.ok(serverSource.includes('sevenDayCapUsedRatio: deriveContributionCapUsedRatio({'));
  assert.ok(!serverSource.includes("if ((input.provider ?? '').trim().toLowerCase() !== 'anthropic') return null;"));
});

test('analytics table highlights exhausted usage windows for Codex rows too', () => {
  const tableSource = readFileSync(join(uiRoot, 'src/components/analytics/AnalyticsTables.tsx'), 'utf8');

  assert.ok(!tableSource.includes("if (provider !== 'anthropic') return '';"));
  assert.ok(tableSource.includes("if (input.utilizationRatio !== null && input.utilizationRatio >= 1) return styles.statusPillMaxed;"));
});
