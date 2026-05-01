import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function printUsage() {
  console.log(
    [
      'Innies CLI',
      '',
      'Usage:',
      '  innies login --token <in_token> [--base-url <url>] [--model <id>]',
      '  innies doctor',
      '  innies claude [-- <claude args...>]',
      '  innies codex [-- <codex args...>]',
      '  innies link claude',
      '  innies unlink claude',
      '  innies --version',
      ''
    ].join('\n')
  );
}

export function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

export function normalizeBaseUrl(input) {
  const value = (input ?? 'https://innies-api.exe.xyz').trim();
  if (!value) {
    fail('Base URL cannot be empty.');
  }

  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    fail(`Invalid base URL: ${value}`);
  }
}

export function parseFlag(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) {
    return undefined;
  }

  const value = args[idx + 1];
  if (!value || value.startsWith('--')) {
    fail(`Missing value for ${name}`);
  }

  return value;
}

export function buildCorrelationId() {
  return randomUUID();
}

/**
 * Read the `version` field from the CLI package.json that ships alongside
 * the installed module. Resolves relative to this source file so it works
 * from both the source tree (ESM imports) and a globally-installed node
 * package (symlinked bin → lib/node_modules/innies/bin).
 */
export async function readPackageVersion() {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, '..', 'package.json');
  try {
    const raw = await readFile(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
      return 'unknown';
    }
    return parsed.version;
  } catch {
    return 'unknown';
  }
}

/**
 * Per-CLI-invocation session id.
 *
 * Propagated to upstream requests as the `x-openclaw-session-id` header so the
 * Innies API can group every turn of a single `innies codex` / `innies claude`
 * run under one session. Read by `resolveOpenClawCorrelation` in
 * api/src/routes/proxy.ts.
 *
 * Must be stable for the lifetime of one CLI invocation and unique across
 * invocations. UUID v4 meets both.
 */
export function buildSessionId() {
  return randomUUID();
}

export async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
