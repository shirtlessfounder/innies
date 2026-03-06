import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveWrappedBinary } from '../src/commands/wrapperRuntime.js';

test('resolveWrappedBinary follows a symlinked wrapper path to the real Claude binary', async () => {
  const home = await mkdtemp(join(tmpdir(), 'innies-cli-wrapper-'));
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;

  try {
    const realBinaryDir = join(home, '.local', 'share', 'claude', 'versions');
    const wrapperDir = join(home, '.local', 'bin');
    const realBinary = join(realBinaryDir, '2.1.63');
    const wrapper = join(wrapperDir, 'claude');

    await mkdir(realBinaryDir, { recursive: true });
    await mkdir(wrapperDir, { recursive: true });
    await writeFile(realBinary, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    await symlink(realBinary, wrapper);

    process.env.HOME = home;
    process.env.PATH = `${wrapperDir}:${originalPath ?? ''}`;

    const resolved = resolveWrappedBinary({
      binaryName: 'claude',
      displayName: 'Claude',
      overrideEnvVar: 'INNIES_CLAUDE_BIN'
    });

    assert.equal(resolved, realpathSync(realBinary));
  } finally {
    process.env.HOME = originalHome;
    process.env.PATH = originalPath;
  }
});
