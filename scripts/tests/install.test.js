import assert from 'node:assert/strict';
import { chmod, cp, mkdtemp, mkdir, readlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const sourceInstallPath = join(testDir, '..', 'install.sh');

async function setupFakeRepo(rootDir) {
  const scriptsDir = join(rootDir, 'scripts');
  await mkdir(scriptsDir, { recursive: true });
  await cp(sourceInstallPath, join(scriptsDir, 'install.sh'));
  await chmod(join(scriptsDir, 'install.sh'), 0o755);

  const scriptNames = [
    'innies-token-add.sh',
    'innies-token-rotate.sh',
    'innies-token-pause.sh',
    'innies-token-label-set.sh',
    'innies-token-contribution-cap-set.sh',
    'innies-token-refresh-token-set.sh',
    'innies-token-probe-run.sh',
    'innies-token-usage-refresh.sh',
    'innies-buyer-key-create.sh',
    'innies-org-buyer-key-recover.sh',
    'innies-buyer-preference-set.sh',
    'innies-buyer-preference-get.sh',
    'innies-buyer-preference-check.sh',
    'innies-slo-check.sh',
    'issue80-local-replay.sh',
    'issue80-direct-anthropic.sh',
    'issue80-prod-journal.sh',
  ];

  for (const scriptName of scriptNames) {
    await writeFile(join(scriptsDir, scriptName), '#!/usr/bin/env bash\n');
  }
}

function runInstall(installPath, homeDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [installPath], {
      env: {
        ...process.env,
        HOME: homeDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test('install prefers stable home repo when invoked from a temp worker path', async () => {
  const homeDir = await mkdtemp('/tmp/innies-home-');
  const canonicalRoot = join(homeDir, 'innies');
  const tempRoot = await mkdtemp('/tmp/innies-worker-');

  await setupFakeRepo(canonicalRoot);
  await setupFakeRepo(tempRoot);

  const result = await runInstall(join(tempRoot, 'scripts', 'install.sh'), homeDir);

  assert.equal(result.code, 0, result.stderr);
  const usageRefreshTarget = await readlink(join(homeDir, '.local', 'bin', 'innies-token-usage-refresh'));
  assert.equal(usageRefreshTarget, join(canonicalRoot, 'scripts', 'innies-token-usage-refresh.sh'));
  const buyerKeyRecoverTarget = await readlink(join(homeDir, '.local', 'bin', 'innies-org-buyer-key-recover'));
  assert.equal(buyerKeyRecoverTarget, join(canonicalRoot, 'scripts', 'innies-org-buyer-key-recover.sh'));
});
