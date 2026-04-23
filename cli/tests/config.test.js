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
    apiBaseUrl: 'https://api.innies.computer',
    defaultModel: 'innies/default',
    updatedAt: '2026-03-06T00:00:00.000Z'
  }));

  const configModule = await importConfigModuleForHome(home);
  const config = await configModule.loadConfig(true);

  assert.equal(config.defaultModel, 'claude-opus-4-7');
  assert.deepEqual(config.providerDefaults, {
    anthropic: 'claude-opus-4-7',
    openai: 'gpt-5.5'
  });
  assert.equal(configModule.resolveProviderDefaultModel(config, 'anthropic'), 'claude-opus-4-7');
  assert.equal(configModule.resolveProviderDefaultModel(config, 'openai'), 'gpt-5.5');
});

test('saveConfig with anthropic model keeps codex lane on openai default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'innies-cli-config-'));
  const configModule = await importConfigModuleForHome(home);
  const saved = await configModule.saveConfig('in_live_test', 'https://api.innies.computer', 'claude-opus-4-6');

  assert.equal(saved.defaultModel, 'claude-opus-4-6');
  assert.deepEqual(saved.providerDefaults, {
    anthropic: 'claude-opus-4-6',
    openai: 'gpt-5.5'
  });
  assert.equal(configModule.resolveProviderDefaultModel(saved, 'anthropic'), 'claude-opus-4-6');
  assert.equal(configModule.resolveProviderDefaultModel(saved, 'openai'), 'gpt-5.5');
});

test('saveConfig with unknown model preserves fallback but leaves provider defaults unchanged', async () => {
  const home = await mkdtemp(join(tmpdir(), 'innies-cli-config-'));
  const configModule = await importConfigModuleForHome(home);
  const saved = await configModule.saveConfig('in_live_test', 'https://api.innies.computer', 'future-model-x');

  assert.equal(saved.defaultModel, 'future-model-x');
  assert.deepEqual(saved.providerDefaults, {
    anthropic: 'claude-opus-4-7',
    openai: 'gpt-5.5'
  });
  assert.equal(configModule.resolveProviderDefaultModel(saved, 'anthropic'), 'claude-opus-4-7');
  assert.equal(configModule.resolveProviderDefaultModel(saved, 'openai'), 'gpt-5.5');
});

test('loadConfig auto-upgrades stale anthropic default from a previous CLI version', async () => {
  const home = await mkdtemp(join(tmpdir(), 'innies-cli-config-'));
  await mkdir(join(home, '.innies'), { recursive: true });
  const configFile = join(home, '.innies', 'config.json');

  // Simulate a config saved by 0.1.12 (when claude-opus-4-6 was the
  // hardcoded anthropic default).
  await writeFile(configFile, JSON.stringify({
    version: 1,
    token: 'in_live_migrated',
    apiBaseUrl: 'https://innies-api.exe.xyz',
    defaultModel: 'claude-opus-4-6',
    providerDefaults: {
      anthropic: 'claude-opus-4-6',
      openai: 'gpt-5.4'
    },
    updatedAt: '2026-04-18T00:00:00.000Z'
  }));

  const configModule = await importConfigModuleForHome(home);
  const config = await configModule.loadConfig(true);

  // In-memory config reflects the new default immediately.
  assert.equal(config.defaultModel, 'claude-opus-4-7');
  assert.deepEqual(config.providerDefaults, {
    anthropic: 'claude-opus-4-7',
    openai: 'gpt-5.5'
  });

  // Config file on disk is rewritten so subsequent loads don't need
  // to re-run the migration.
  const { readFile } = await import('node:fs/promises');
  const persisted = JSON.parse(await readFile(configFile, 'utf8'));
  assert.equal(persisted.defaultModel, 'claude-opus-4-7');
  assert.equal(persisted.providerDefaults.anthropic, 'claude-opus-4-7');
  assert.notEqual(persisted.updatedAt, '2026-04-18T00:00:00.000Z');
});

test('loadConfig leaves an explicit non-stale anthropic default alone', async () => {
  const home = await mkdtemp(join(tmpdir(), 'innies-cli-config-'));
  await mkdir(join(home, '.innies'), { recursive: true });

  // User explicitly chose sonnet (not in the stale set) — we must not
  // silently rewrite this to opus.
  await writeFile(join(home, '.innies', 'config.json'), JSON.stringify({
    version: 1,
    token: 'in_live_explicit',
    apiBaseUrl: 'https://innies-api.exe.xyz',
    defaultModel: 'claude-sonnet-4-6',
    providerDefaults: {
      anthropic: 'claude-sonnet-4-6',
      openai: 'gpt-5.5'
    },
    updatedAt: '2026-04-18T00:00:00.000Z'
  }));

  const configModule = await importConfigModuleForHome(home);
  const config = await configModule.loadConfig(true);

  assert.equal(config.defaultModel, 'claude-sonnet-4-6');
  assert.equal(config.providerDefaults.anthropic, 'claude-sonnet-4-6');
  assert.equal(config.updatedAt, '2026-04-18T00:00:00.000Z');
});
