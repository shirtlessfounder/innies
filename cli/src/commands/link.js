import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../config.js';
import { fail } from '../utils.js';

const INNIES_CLAUDE_WRAPPER_MARKER = 'exec innies claude "$@"';

function wrapperPath() {
  return `${homedir()}/.local/bin/claude`;
}

async function classifyExistingClaudePath(path) {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      return 'external';
    }

    if (!stats.isFile()) {
      return 'external';
    }

    const content = await readFile(path, 'utf8');
    return content.includes(INNIES_CLAUDE_WRAPPER_MARKER) ? 'managed' : 'external';
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }
}

export async function assertClaudeLinkPathSafe(path = wrapperPath()) {
  const classification = await classifyExistingClaudePath(path);
  if (classification === 'external') {
    fail(
      `Refusing to overwrite existing ${path}. Use innies claude directly or move the current Claude binary before linking.`
    );
  }
}

export async function runLinkClaude() {
  const config = await loadConfig(true);
  if (!config) {
    fail('Not logged in. Run: innies login --token <in_token>');
  }

  const path = wrapperPath();
  await mkdir(dirname(path), { recursive: true });
  await assertClaudeLinkPathSafe(path);

  const script = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if command -v innies >/dev/null 2>&1; then',
    '  exec innies claude "$@"',
    'fi',
    'exec innies claude "$@"'
  ].join('\n');

  await writeFile(path, `${script}\n`, { mode: 0o755 });

  console.log('Claude wrapper linked.');
  console.log(`Created: ${path}`);
  console.log('Ensure ~/.local/bin is before other Claude install paths in PATH.');
}
