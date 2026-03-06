import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fail, normalizeBaseUrl } from './utils.js';
import {
  defaultAnthropicModel,
  defaultOpenAiModel,
  defaultProviderModels as defaultProviderModelsBase,
  inferModelProvider,
  normalizeLegacyFallbackModel,
  normalizeModel,
  normalizeProviderDefaults,
  providerDefaultsFromModelHint
} from './modelSelection.js';

const LEGACY_DEFAULT_MODEL = defaultAnthropicModel();
const PRIMARY_CONFIG_PATH = join(homedir(), '.innies', 'config.json');
const LEGACY_CONFIG_PATH = join(homedir(), '.headroom', 'config.json');

function buildConfigRecord(input) {
  const token = normalizeModel(input.token);
  const apiBaseUrl = normalizeModel(input.apiBaseUrl);
  const legacyFallbackModel = normalizeLegacyFallbackModel(input.defaultModel);

  if (!token || !apiBaseUrl) {
    return null;
  }

  const providerDefaults = normalizeProviderDefaults(input.providerDefaults, legacyFallbackModel);
  const fallbackModel = legacyFallbackModel
    ?? normalizeLegacyFallbackModel(input.providerDefaults?.anthropic)
    ?? providerDefaults.anthropic
    ?? LEGACY_DEFAULT_MODEL;

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
  const normalizedModel = normalizeLegacyFallbackModel(defaultModel) ?? normalizeModel(defaultModel);
  const providerDefaults = normalizedModel
    ? providerDefaultsFromModelHint(normalizedModel)
    : defaultProviderModelsBase();
  const selectedProvider = inferModelProvider(normalizedModel);

  const config = {
    version: 1,
    token,
    apiBaseUrl: normalizeBaseUrl(apiBaseUrl),
    defaultModel: normalizedModel && selectedProvider !== 'openai'
      ? normalizedModel
      : providerDefaults.anthropic,
    providerDefaults,
    updatedAt: new Date().toISOString()
  };

  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return config;
}

export function defaultProviderModels() {
  return defaultProviderModelsBase();
}

export function resolveProviderDefaultModel(config, provider) {
  const normalizedProvider = provider === 'codex' ? 'openai' : provider;
  if (normalizedProvider === 'anthropic') {
    return normalizeModel(config?.providerDefaults?.anthropic)
      ?? normalizeModel(config?.defaultModel)
      ?? defaultAnthropicModel();
  }
  if (normalizedProvider === 'openai') {
    return normalizeModel(config?.providerDefaults?.openai)
      ?? normalizeModel(config?.defaultModel)
      ?? defaultOpenAiModel();
  }
  return normalizeModel(config?.defaultModel) ?? LEGACY_DEFAULT_MODEL;
}
