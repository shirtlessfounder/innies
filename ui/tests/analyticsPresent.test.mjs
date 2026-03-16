import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatCount,
  formatSummaryUnitsCompact,
} from '../src/lib/analytics/present.ts';

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
