import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const scriptPath = join(repoRoot, 'scripts', 'innies-slo-check.sh');

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createFakeCurlDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'innies-slo-check-'));
  tempDirs.push(dir);

  const fakeCurlPath = join(dir, 'curl');
  await writeFile(fakeCurlPath, `#!/usr/bin/env bash
set -euo pipefail

url="\${@: -1}"

if [[ "$url" == *"/v1/admin/analytics/system?window=24h" ]]; then
  cat <<'EOF'
{"ttfbP95Ms":500,"errorRate":0.01,"fallbackRate":0.05,"totalRequests":100}
200
EOF
  exit 0
fi

if [[ "$url" == *"/v1/admin/analytics/tokens/routing?window=24h" ]]; then
  cat <<'EOF'
{"tokens":[{"fallbackCount":20,"totalAttempts":40},{"fallbackCount":30,"totalAttempts":60}]}
200
EOF
  exit 0
fi

echo "unexpected url: $url" >&2
exit 1
`);
  await chmod(fakeCurlPath, 0o755);

  return dir;
}

describe('innies-slo-check script', () => {
  it('prints the fallback row from the routing-derived aggregate', async () => {
    const fakeCurlDir = await createFakeCurlDir();

    const { stdout } = await execFile(scriptPath, ['24h'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        INNIES_ADMIN_API_KEY: 'admin-test-token',
        INNIES_ENV_FILE: join(fakeCurlDir, 'missing.env'),
        PATH: `${fakeCurlDir}:${process.env.PATH ?? ''}`
      }
    });

    expect(stdout).toMatch(/Fallback rate\s+flag > 20%\s+"?50%"?\s+FLAG/);
    expect(stdout).toMatch(/\(routing cross-check: per-token aggregate fallback rate = "?50%"?\)/);
    expect(stdout).toMatch(/Timeout rate\s+<= 2\.0%\s+"?1%"?\s+PASS/);
    expect(stdout).toMatch(/Tool-loop success rate\s+>= 95\.0%\s+"?99%"?\s+PASS/);
  });
});
