import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareCodexAuthOverlay } from '../src/commands/codexAuthOverlay.js';

test('prepareCodexAuthOverlay forces api-key auth without copying stale chatgpt auth state', async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'innies-codex-auth-fixture-'));
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  const sourceCodexHome = join(fixtureRoot, '.codex-source');
  await mkdir(join(sourceCodexHome, 'rules'), { recursive: true });
  await writeFile(join(sourceCodexHome, 'config.toml'), 'model = "gpt-5.4"\n');
  await writeFile(
    join(sourceCodexHome, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { refresh_token: 'rt_stale_chatgpt' }
    }, null, 2)
  );
  await writeFile(join(sourceCodexHome, 'history.jsonl'), '{"stale":true}\n');
  await writeFile(join(sourceCodexHome, 'rules', 'default.rules'), 'allow = true\n');

  const overlay = await prepareCodexAuthOverlay({
    buyerToken: 'in_live_test',
    sourceCodexHome,
    tmpRoot: fixtureRoot
  });

  const auth = JSON.parse(await readFile(join(overlay.codexHome, 'auth.json'), 'utf8'));
  assert.deepEqual(auth, {
    auth_mode: 'apikey',
    OPENAI_API_KEY: 'in_live_test'
  });
  assert.equal(await readFile(join(overlay.codexHome, 'config.toml'), 'utf8'), 'model = "gpt-5.4"\n');
  assert.equal(lstatSync(join(overlay.codexHome, 'rules')).isSymbolicLink(), true);
  await assert.rejects(
    () => readFile(join(overlay.codexHome, 'history.jsonl'), 'utf8'),
    { code: 'ENOENT' }
  );

  overlay.cleanup();

  await assert.rejects(
    () => readFile(join(overlay.codexHome, 'auth.json'), 'utf8'),
    { code: 'ENOENT' }
  );
});
