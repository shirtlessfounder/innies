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

test('forwards INNIES_SESSION_ID into the codex env_http_headers config', () => {
  const args = buildCodexArgs({ args: [], model: 'gpt-5.4', proxyUrl: 'https://api.innies.computer/v1/proxy/v1' });

  assert.ok(
    args.includes('model_providers.innies.env_http_headers."x-openclaw-session-id"="INNIES_SESSION_ID"'),
    'expected codex config to inject x-openclaw-session-id from INNIES_SESSION_ID'
  );
});
