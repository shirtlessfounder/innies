import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../config.js';
import { fail } from '../utils.js';

const WRAPPER_PATH = `${homedir()}/.local/bin/claude`;

export async function runLinkClaude() {
  const config = await loadConfig(true);
  if (!config) {
    fail('Not logged in. Run: innies login --token <hr_token>');
  }

  await mkdir(dirname(WRAPPER_PATH), { recursive: true });

  const script = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if command -v innies >/dev/null 2>&1; then',
    '  exec innies claude "$@"',
    'fi',
    'exec headroom claude "$@"'
  ].join('\n');

  await writeFile(WRAPPER_PATH, `${script}\n`, { mode: 0o755 });

  console.log('Claude wrapper linked.');
  console.log(`Created: ${WRAPPER_PATH}`);
  console.log('Ensure ~/.local/bin is before other Claude install paths in PATH.');
}
