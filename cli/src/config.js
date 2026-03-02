import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fail, normalizeBaseUrl } from './utils.js';

const DEFAULT_MODEL = 'innies/default';
const PRIMARY_CONFIG_PATH = join(homedir(), '.innies', 'config.json');
const LEGACY_CONFIG_PATH = join(homedir(), '.headroom', 'config.json');

export function configPath() {
  return PRIMARY_CONFIG_PATH;
}

export async function loadConfig(required = true) {
  const candidates = [PRIMARY_CONFIG_PATH, LEGACY_CONFIG_PATH];
  let lastError = null;

  for (const file of candidates) {
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw);

      if (parsed.version !== 1 || !parsed.token || !parsed.apiBaseUrl || !parsed.defaultModel) {
        fail(`Invalid config at ${file}. Run: innies login --token <hr_token>`);
      }

      return {
        version: 1,
        token: parsed.token,
        apiBaseUrl: normalizeBaseUrl(parsed.apiBaseUrl),
        defaultModel: parsed.defaultModel,
        updatedAt: parsed.updatedAt ?? new Date(0).toISOString()
      };
    } catch (error) {
      lastError = error;
    }
  }

  if (!required) {
    return null;
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  fail(`Missing or unreadable config (${PRIMARY_CONFIG_PATH}): ${message}`);
}

export async function saveConfig(token, apiBaseUrl, defaultModel) {
  const file = configPath();
  await mkdir(dirname(file), { recursive: true });

  const config = {
    version: 1,
    token,
    apiBaseUrl: normalizeBaseUrl(apiBaseUrl),
    defaultModel: defaultModel.trim() || DEFAULT_MODEL,
    updatedAt: new Date().toISOString()
  };

  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return config;
}

export function defaultModelId() {
  return DEFAULT_MODEL;
}
