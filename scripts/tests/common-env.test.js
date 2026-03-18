import assert from 'node:assert/strict';
import { chmod, cp, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const sourceCommonPath = join(repoRoot, 'scripts', '_common.sh');

async function setupIsolatedRepo() {
  const repoRootPath = await mkdtemp(join(tmpdir(), 'innies-script-env-'));
  const scriptsDir = join(repoRootPath, 'scripts');
  await mkdir(scriptsDir, { recursive: true });
  await cp(sourceCommonPath, join(scriptsDir, '_common.sh'));

  const inspectPath = join(scriptsDir, 'print-admin-token.sh');
  await writeFile(
    inspectPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'source "${SCRIPT_DIR}/_common.sh"',
      'printf "%s" "${ADMIN_TOKEN:-}"',
      ''
    ].join('\n')
  );
  await chmod(inspectPath, 0o755);

  return { repoRootPath, inspectPath };
}

function runInspectAdminToken(inspectPath, homeDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [inspectPath], {
      env: {
        ...process.env,
        HOME: homeDir
      },
      stdio: ['ignore', 'pipe', 'pipe']
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

function meaningfulStderr(stderr) {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.includes('MallocStackLogging'));
}

test('loads admin token from shared per-user env when repo-local env is absent', async () => {
  const { inspectPath } = await setupIsolatedRepo();
  const homeDir = await mkdtemp(join(tmpdir(), 'innies-script-home-'));
  const sharedConfigDir = join(homeDir, '.config', 'innies');
  await mkdir(sharedConfigDir, { recursive: true });
  await writeFile(
    join(sharedConfigDir, '.env'),
    'INNIES_ADMIN_API_KEY=in_admin_from_shared_config\n'
  );

  const result = await runInspectAdminToken(inspectPath, homeDir);

  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'in_admin_from_shared_config');
  assert.deepEqual(meaningfulStderr(result.stderr), []);
});

test('repo-local env overrides shared per-user env', async () => {
  const { repoRootPath, inspectPath } = await setupIsolatedRepo();
  const homeDir = await mkdtemp(join(tmpdir(), 'innies-script-home-'));
  const sharedConfigDir = join(homeDir, '.config', 'innies');
  await mkdir(sharedConfigDir, { recursive: true });
  await writeFile(
    join(sharedConfigDir, '.env'),
    'INNIES_ADMIN_API_KEY=in_admin_from_shared_config\n'
  );
  await writeFile(
    join(repoRootPath, 'scripts', '.env.local'),
    'INNIES_ADMIN_API_KEY=in_admin_from_repo_local\n'
  );

  const result = await runInspectAdminToken(inspectPath, homeDir);

  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'in_admin_from_repo_local');
  assert.deepEqual(meaningfulStderr(result.stderr), []);
});
