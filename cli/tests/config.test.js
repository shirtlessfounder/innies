import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function importConfigModuleForHome(home) {
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const url = new URL(`../src/config.js?home=${encodeURIComponent(home)}&t=${Date.now()}-${Math.random()}`, import.meta.url);
    return await import(url.href);
  } finally {
    process.env.HOME = previousHome;
  }
}

test('sentinel config falls back to provider defaults for both lanes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'innies-cli-config-'));
  await mkdir(join(home, '.innies'), { recursive: true });
  await writeFile(join(home, '.innies', 'config.json'), JSON.stringify({
    version: 1,
    token: 'in_live_legacy',
    apiBaseUrl: 'https://gateway.innies.ai',
    defaultModel: 'innies/default',
    updatedAt: '2026-03-06T00:00:00.000Z'
  }));

  const configModule = await importConfigModuleForHome(home);
  const config = await configModule.loadConfig(true);

  assert.equal(config.defaultModel, 'claude-opus-4-6');
  assert.deepEqual(config.providerDefaults, {
    anthropic: 'claude-opus-4-6',
    openai: 'gpt-5.4'
  });
  assert.equal(configModule.resolveProviderDefaultModel(config, 'anthropic'), 'claude-opus-4-6');
  assert.equal(configModule.resolveProviderDefaultModel(config, 'openai'), 'gpt-5.4');
});

test('saveConfig with anthropic model keeps codex lane on openai default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'innies-cli-config-'));
  const configModule = await importConfigModuleForHome(home);
  const saved = await configModule.saveConfig('in_live_test', 'https://gateway.innies.ai', 'claude-opus-4-6');

  assert.equal(saved.defaultModel, 'claude-opus-4-6');
  assert.deepEqual(saved.providerDefaults, {
    anthropic: 'claude-opus-4-6',
    openai: 'gpt-5.4'
  });
  assert.equal(configModule.resolveProviderDefaultModel(saved, 'anthropic'), 'claude-opus-4-6');
  assert.equal(configModule.resolveProviderDefaultModel(saved, 'openai'), 'gpt-5.4');
});

test('saveConfig with unknown model preserves fallback but leaves provider defaults unchanged', async () => {
  const home = await mkdtemp(join(tmpdir(), 'innies-cli-config-'));
  const configModule = await importConfigModuleForHome(home);
  const saved = await configModule.saveConfig('in_live_test', 'https://gateway.innies.ai', 'future-model-x');

  assert.equal(saved.defaultModel, 'future-model-x');
  assert.deepEqual(saved.providerDefaults, {
    anthropic: 'claude-opus-4-6',
    openai: 'gpt-5.4'
  });
  assert.equal(configModule.resolveProviderDefaultModel(saved, 'anthropic'), 'claude-opus-4-6');
  assert.equal(configModule.resolveProviderDefaultModel(saved, 'openai'), 'gpt-5.4');
});
