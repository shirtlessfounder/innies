import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCodexArgs, hasExplicitModelArg } from '../src/commands/codex.js';

test('detects explicit codex model override forms', () => {
  assert.equal(hasExplicitModelArg(['--model', 'gpt-5.5']), true);
  assert.equal(hasExplicitModelArg(['--model=gpt-5.5']), true);
  assert.equal(hasExplicitModelArg(['-mgpt-5.5']), true);
  assert.equal(hasExplicitModelArg(['--help']), false);
});

test('does not inject default model when user passes --model=<id>', () => {
  const args = buildCodexArgs({ args: ['--model=gpt-5.5', '--help'], model: 'gpt-5.4' });
  assert.equal(args.includes('--model'), false);
  assert.deepEqual(args.slice(-2), ['--model=gpt-5.5', '--help']);
});

test('injects default model when user does not pass a model override', () => {
  const args = buildCodexArgs({ args: ['--help'], model: 'gpt-5.4' });
  assert.ok(args.includes('--model'));
  assert.deepEqual(args.slice(-3), ['--model', 'gpt-5.4', '--help']);
});
