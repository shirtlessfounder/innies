import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveClaudeSessionModel } from '../src/commands/claude.js';

test('uses explicit claude --model value when provided as a separate arg', () => {
  assert.equal(
    resolveClaudeSessionModel(['--model', 'claude-sonnet-4-5', '--print'], 'claude-opus-4-6'),
    'claude-sonnet-4-5'
  );
});

test('uses explicit claude --model=<id> value when provided inline', () => {
  assert.equal(
    resolveClaudeSessionModel(['--model=claude-sonnet-4-5', '--print'], 'claude-opus-4-6'),
    'claude-sonnet-4-5'
  );
});

test('falls back to the configured model when no explicit claude model override is present', () => {
  assert.equal(
    resolveClaudeSessionModel(['--print'], 'claude-opus-4-6'),
    'claude-opus-4-6'
  );
});
