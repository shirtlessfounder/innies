import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fail, normalizeBaseUrl } from './utils.js';

const DEFAULT_MODELS = Object.freeze({
  anthropic: 'claude-opus-4-6',
  openai: 'gpt-5.4'
});
const LEGACY_DEFAULT_MODEL = DEFAULT_MODELS.anthropic;
const PRIMARY_CONFIG_PATH = join(homedir(), '.innies', 'config.json');
const LEGACY_CONFIG_PATH = join(homedir(), '.headroom', 'config.json');

function normalizeModel(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeProviderDefaults(raw, fallbackModel) {
  const providerDefaults = raw && typeof raw === 'object'
    ? raw
    : {};
  const fallback = normalizeModel(fallbackModel) ?? LEGACY_DEFAULT_MODEL;
  return {
    anthropic: normalizeModel(providerDefaults.anthropic) ?? fallback,
    openai: normalizeModel(providerDefaults.openai) ?? fallback
  };
}

function buildConfigRecord(input) {
  const token = normalizeModel(input.token);
  const apiBaseUrl = normalizeModel(input.apiBaseUrl);
  const fallbackModel = normalizeModel(input.defaultModel)
    ?? normalizeModel(input.providerDefaults?.anthropic)
    ?? normalizeModel(input.providerDefaults?.openai)
    ?? LEGACY_DEFAULT_MODEL;

  if (!token || !apiBaseUrl) {
    return null;
  }

  const providerDefaults = normalizeProviderDefaults(input.providerDefaults, fallbackModel);
  return {
    version: 1,
    token,
    apiBaseUrl: normalizeBaseUrl(apiBaseUrl),
    defaultModel: fallbackModel,
    providerDefaults,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date(0).toISOString()
  };
}

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
      const config = buildConfigRecord(parsed);

      if (parsed.version !== 1 || !config) {
        fail(`Invalid config at ${file}. Run: innies login --token <in_token>`);
      }

      return config;
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
  const normalizedModel = normalizeModel(defaultModel);
  const providerDefaults = normalizedModel
    ? {
      anthropic: normalizedModel,
      openai: normalizedModel
    }
    : defaultProviderModels();

  const config = {
    version: 1,
    token,
    apiBaseUrl: normalizeBaseUrl(apiBaseUrl),
    defaultModel: normalizedModel ?? LEGACY_DEFAULT_MODEL,
    providerDefaults,
    updatedAt: new Date().toISOString()
  };

  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return config;
}

export function defaultModelId() {
  return LEGACY_DEFAULT_MODEL;
}

export function defaultProviderModels() {
  return { ...DEFAULT_MODELS };
}

export function resolveProviderDefaultModel(config, provider) {
  const normalizedProvider = provider === 'codex' ? 'openai' : provider;
  if (normalizedProvider === 'anthropic') {
    return normalizeModel(config?.providerDefaults?.anthropic)
      ?? normalizeModel(config?.defaultModel)
      ?? DEFAULT_MODELS.anthropic;
  }
  if (normalizedProvider === 'openai') {
    return normalizeModel(config?.providerDefaults?.openai)
      ?? normalizeModel(config?.defaultModel)
      ?? DEFAULT_MODELS.openai;
  }
  return normalizeModel(config?.defaultModel) ?? LEGACY_DEFAULT_MODEL;
}
