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
  const args = buildCodexArgs({ args: ['--help'], model: 'gpt-5.4', proxyUrl: 'https://api.innies.computer/v1/proxy/v1' });
  assert.ok(args.includes('--model'));
  assert.deepEqual(args.slice(-3), ['--model', 'gpt-5.4', '--help']);
});

test('injects a custom codex provider config that points at the innies proxy', () => {
  const args = buildCodexArgs({ args: ['--help'], model: 'gpt-5.4', proxyUrl: 'https://api.innies.computer/v1/proxy/v1' });

  assert.ok(args.includes('model_provider="innies"'));
  assert.ok(args.includes('model_providers.innies.base_url="https://api.innies.computer/v1/proxy/v1"'));
  assert.ok(args.includes('model_providers.innies.requires_openai_auth=false'));
  assert.ok(args.includes('model_providers.innies.supports_websockets=false'));
  assert.ok(args.includes('responses_websockets_v2=false'));
});

test('does not inject env_http_headers — headers are stamped by the local bridge', () => {
  const args = buildCodexArgs({ args: [], model: 'gpt-5.4', proxyUrl: 'https://bridge.local/v1/proxy/v1' });

  // Header injection now happens in codexProxy.js on every forwarded request.
  // Emitting env_http_headers here was redundant and unreliable (codex does
  // not propagate them for our header names), so buildCodexArgs no longer
  // emits any env_http_headers entries.
  assert.equal(
    args.some((entry) => typeof entry === 'string' && entry.includes('env_http_headers')),
    false
  );
});
