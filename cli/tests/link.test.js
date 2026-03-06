import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function importLinkModuleForHome(home) {
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const url = new URL(`../src/commands/link.js?home=${encodeURIComponent(home)}&t=${Date.now()}-${Math.random()}`, import.meta.url);
    return await import(url.href);
  } finally {
    process.env.HOME = previousHome;
  }
}

test('assertClaudeLinkPathSafe allows an innies-managed wrapper file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'innies-cli-link-'));
  const path = join(home, '.local', 'bin', 'claude');
  await mkdir(join(home, '.local', 'bin'), { recursive: true });
  await writeFile(path, '#!/usr/bin/env bash\nexec innies claude "$@"\n', { mode: 0o755 });

  const linkModule = await importLinkModuleForHome(home);
  await assert.doesNotReject(linkModule.assertClaudeLinkPathSafe(path));
});

test('assertClaudeLinkPathSafe rejects overwriting a real Claude symlink', async () => {
  const home = await mkdtemp(join(tmpdir(), 'innies-cli-link-'));
  const versionsDir = join(home, '.local', 'share', 'claude', 'versions');
  const wrapperDir = join(home, '.local', 'bin');
  const realBinary = join(versionsDir, '2.1.63');
  const wrapper = join(wrapperDir, 'claude');

  await mkdir(versionsDir, { recursive: true });
  await mkdir(wrapperDir, { recursive: true });
  await writeFile(realBinary, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  await symlink(realBinary, wrapper);

  const linkModule = await importLinkModuleForHome(home);

  const exitCalls = [];
  const originalExit = process.exit;
  const originalError = console.error;
  process.exit = ((code) => {
    exitCalls.push(code);
    throw new Error(`process.exit:${code}`);
  });
  console.error = () => {};

  try {
    await assert.rejects(
      linkModule.assertClaudeLinkPathSafe(wrapper),
      /process\.exit:1/
    );
    assert.deepEqual(exitCalls, [1]);
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
});
