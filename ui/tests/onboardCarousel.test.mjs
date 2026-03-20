import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ONBOARDING_FILES,
  buildPane,
} from '../src/app/onboard/paneData.ts';
import {
  chunkIntoPanePages,
  clampPageIndex,
  getPageButtonState,
} from '../src/app/onboard/carousel.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiRoot = join(__dirname, '..');

test('onboard page includes conductor onboarding in the pane file list', () => {
  assert.deepEqual(ONBOARDING_FILES, [
    'CLAUDE_CODEX_OAUTH_TOKENS.md',
    'CLI_ONBOARDING.md',
    'OPENCLAW_ONBOARDING.md',
    'CONDUCTOR_ONBOARDING.md',
  ]);
});

test('buildPane uses the markdown heading as the pane title', () => {
  const pane = buildPane('CONDUCTOR_ONBOARDING.md', '# Conductor Onboarding\n\nbody');

  assert.equal(pane.title, 'Conductor Onboarding');
  assert.equal(pane.lines[0]?.kind, 'heading1');
});

test('chunkIntoPanePages groups four guides into two 3-pane pages', () => {
  const pages = chunkIntoPanePages(ONBOARDING_FILES, 3);

  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0], [
    'CLAUDE_CODEX_OAUTH_TOKENS.md',
    'CLI_ONBOARDING.md',
    'OPENCLAW_ONBOARDING.md',
  ]);
  assert.deepEqual(pages[1], ['CONDUCTOR_ONBOARDING.md']);
});

test('clampPageIndex keeps the page index inside the page range', () => {
  assert.equal(clampPageIndex(-1, 2), 0);
  assert.equal(clampPageIndex(0, 2), 0);
  assert.equal(clampPageIndex(1, 2), 1);
  assert.equal(clampPageIndex(2, 2), 1);
});

test('getPageButtonState disables nav buttons at the first and last page', () => {
  assert.deepEqual(getPageButtonState(0, 2), {
    canScrollLeft: false,
    canScrollRight: true,
  });
  assert.deepEqual(getPageButtonState(1, 2), {
    canScrollLeft: true,
    canScrollRight: false,
  });
});

test('onboard header copy tells the user to copy and send the docs to an agent', () => {
  const source = readFileSync(join(uiRoot, 'src/app/onboard/OnboardingPaneCarousel.tsx'), 'utf8');

  assert.ok(source.includes('COPY AND SEND TO AGENT TO SET UP'));
  assert.ok(!source.includes('3 PANES PER PAGE · SCROLL EACH PANE INDEPENDENTLY'));
  assert.ok(!source.includes('workspaceMetaText'));
});

test('onboard header layout splits label left, hint center, and controls right', () => {
  const styles = readFileSync(join(uiRoot, 'src/app/onboard/page.module.css'), 'utf8');

  assert.ok(styles.includes('grid-template-columns: 1fr auto 1fr;'));
  assert.ok(styles.includes('grid-column: 1;'));
  assert.ok(styles.includes('justify-self: start;'));
  assert.ok(styles.includes('grid-column: 2;'));
  assert.ok(styles.includes('justify-self: center;'));
  assert.ok(styles.includes('grid-column: 3;'));
  assert.ok(styles.includes('justify-self: end;'));
});

test('onboard pager buttons mirror the rounded analytics control styling', () => {
  const styles = readFileSync(join(uiRoot, 'src/app/onboard/page.module.css'), 'utf8');

  assert.ok(styles.includes('border-radius: 6px;'));
  assert.ok(styles.includes('background: rgba(248, 251, 253, 0.24);'));
  assert.ok(styles.includes('background: rgba(248, 251, 253, 0.52);'));
});

test('mobile pane header keeps the filename and copy button on one row', () => {
  const styles = readFileSync(join(uiRoot, 'src/app/onboard/page.module.css'), 'utf8');

  assert.ok(styles.includes('@media (max-width: 720px) {'));
  assert.ok(styles.includes('grid-template-columns: auto minmax(0, 1fr) auto;'));
  assert.ok(styles.includes('.paneChromeActions {\n    justify-self: end;'));
});
