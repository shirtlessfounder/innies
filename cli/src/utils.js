import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

export function printUsage() {
  console.log(
    [
      'Innies CLI',
      '',
      'Usage:',
      '  innies login --token <hr_token> [--base-url <url>] [--model <id>]',
      '  innies doctor',
      '  innies claude [-- <claude args...>]',
      '  innies link claude',
      ''
    ].join('\n')
  );
}

export function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

export function normalizeBaseUrl(input) {
  const value = (input ?? 'https://gateway.headroom.ai').trim();
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

export async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
