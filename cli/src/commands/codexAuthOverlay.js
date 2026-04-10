import { copyFile, mkdtemp, readdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const SKIPPED_CODEX_HOME_ENTRIES = new Set([
  'auth.json',
  'cache',
  'history.jsonl',
  'log',
  'sessions',
  'shell_snapshots'
]);

async function mirrorCodexHomeState(sourceCodexHome, overlayCodexHome) {
  const entries = await readdir(sourceCodexHome, { withFileTypes: true }).catch(() => null);
  if (!entries) return;

  for (const entry of entries) {
    if (SKIPPED_CODEX_HOME_ENTRIES.has(entry.name)) {
      continue;
    }

    const sourcePath = join(sourceCodexHome, entry.name);
    const overlayPath = join(overlayCodexHome, entry.name);

    if (entry.isDirectory()) {
      await symlink(sourcePath, overlayPath, process.platform === 'win32' ? 'junction' : 'dir');
      continue;
    }

    if (entry.isSymbolicLink()) {
      await symlink(await readlink(sourcePath), overlayPath);
      continue;
    }

    if (entry.isFile()) {
      await copyFile(sourcePath, overlayPath);
    }
  }
}

export async function prepareCodexAuthOverlay(input) {
  const sourceCodexHome = input.sourceCodexHome?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  const overlayCodexHome = await mkdtemp(join(input.tmpRoot ?? tmpdir(), 'innies-codex-home-'));

  await mirrorCodexHomeState(sourceCodexHome, overlayCodexHome);
  await writeFile(
    join(overlayCodexHome, 'auth.json'),
    `${JSON.stringify({
      auth_mode: 'apikey',
      OPENAI_API_KEY: input.buyerToken
    }, null, 2)}\n`,
    { mode: 0o600 }
  );

  return {
    codexHome: overlayCodexHome,
    cleanup() {
      try {
        rmSync(overlayCodexHome, { recursive: true, force: true });
      } catch {}
    }
  };
}
