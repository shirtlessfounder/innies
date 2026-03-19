import assert from 'node:assert/strict';
import { chmod, cp, mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const sourceBootstrapPath = join(repoRoot, 'scripts', 'conductor-bootstrap.sh');

async function writeExecutable(path, contents) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

async function setupWorkspaceFixture() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'innies-conductor-bootstrap-'));
  const sourceRoot = join(tempRoot, 'source');
  const workspaceRoot = join(tempRoot, 'workspace');
  const fakeBinDir = join(tempRoot, 'bin');
  const installLogPath = join(tempRoot, 'install.log');

  await mkdir(join(sourceRoot, 'api'), { recursive: true });
  await mkdir(join(sourceRoot, 'scripts'), { recursive: true });
  await mkdir(join(sourceRoot, 'ui'), { recursive: true });
  await mkdir(join(workspaceRoot, 'api'), { recursive: true });
  await mkdir(join(workspaceRoot, 'scripts'), { recursive: true });
  await mkdir(join(workspaceRoot, 'ui'), { recursive: true });
  await mkdir(fakeBinDir, { recursive: true });

  await writeFile(join(sourceRoot, 'api', '.env'), 'DATABASE_URL=postgres://bootstrap-test\n');
  await writeFile(join(sourceRoot, 'scripts', '.env.local'), 'INNIES_ADMIN_API_KEY=in_admin_test\n');
  await writeFile(join(sourceRoot, 'ui', '.env.local'), 'NEXT_PUBLIC_API_BASE_URL=http://localhost:4010\n');

  await writeFile(join(workspaceRoot, 'api', 'package.json'), '{"name":"api"}\n');
  await writeFile(join(workspaceRoot, 'api', 'package-lock.json'), '{}\n');
  await writeFile(join(workspaceRoot, 'ui', 'package.json'), '{"name":"ui"}\n');
  await writeFile(join(workspaceRoot, 'ui', 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');

  await cp(sourceBootstrapPath, join(workspaceRoot, 'scripts', 'conductor-bootstrap.sh'));

  const fakeInstaller = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'printf "%s\\t%s\\t%s\\n" "$(basename "$0")" "$PWD" "$*" >> "$LOG_FILE"',
    'mkdir -p node_modules',
    ''
  ].join('\n');
  await writeExecutable(join(fakeBinDir, 'npm'), fakeInstaller);
  await writeExecutable(join(fakeBinDir, 'pnpm'), fakeInstaller);

  return { sourceRoot, workspaceRoot, fakeBinDir, installLogPath };
}

function runBootstrap({ workspaceRoot, sourceRoot, fakeBinDir, installLogPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [join(workspaceRoot, 'scripts', 'conductor-bootstrap.sh')], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        INNIES_CONDUCTOR_SOURCE_ROOT: sourceRoot,
        PATH: `${fakeBinDir}:${process.env.PATH}`,
        LOG_FILE: installLogPath
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

test('symlinks canonical env files and installs missing deps once', async () => {
  const fixture = await setupWorkspaceFixture();
  const expectedApiEnv = await realpath(join(fixture.sourceRoot, 'api', '.env'));
  const expectedScriptsEnv = await realpath(join(fixture.sourceRoot, 'scripts', '.env.local'));
  const expectedUiEnv = await realpath(join(fixture.sourceRoot, 'ui', '.env.local'));
  const expectedApiDir = await realpath(join(fixture.workspaceRoot, 'api'));
  const expectedUiDir = await realpath(join(fixture.workspaceRoot, 'ui'));

  const firstRun = await runBootstrap(fixture);
  assert.equal(firstRun.code, 0, firstRun.stderr);

  assert.equal(await realpath(join(fixture.workspaceRoot, 'api', '.env')), expectedApiEnv);
  assert.equal(await realpath(join(fixture.workspaceRoot, 'scripts', '.env.local')), expectedScriptsEnv);
  assert.equal(await realpath(join(fixture.workspaceRoot, 'ui', '.env.local')), expectedUiEnv);

  const secondRun = await runBootstrap(fixture);
  assert.equal(secondRun.code, 0, secondRun.stderr);

  const logLines = (await readFile(fixture.installLogPath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(logLines, [
    `npm\t${expectedApiDir}\tinstall`,
    `pnpm\t${expectedUiDir}\tinstall`
  ]);
});

test('fails clearly when a required canonical env file is missing', async () => {
  const fixture = await setupWorkspaceFixture();
  await writeFile(join(fixture.sourceRoot, 'ui', '.env.local'), '');
  await writeFile(join(fixture.sourceRoot, 'api', '.env'), '');

  const result = await runBootstrap(fixture);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /missing required source env file/i);
});
