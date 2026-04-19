import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fail, normalizeBaseUrl } from './utils.js';
import {
  defaultAnthropicModel,
  defaultOpenAiModel,
  defaultProviderModels as defaultProviderModelsBase,
  inferModelProvider,
  isStaleProviderDefault,
  migrateStaleProviderDefaults,
  normalizeLegacyFallbackModel,
  normalizeModel,
  normalizeProviderDefaults,
  providerDefaultsFromModelHint
} from './modelSelection.js';

const LEGACY_DEFAULT_MODEL = defaultAnthropicModel();
const PRIMARY_CONFIG_PATH = join(homedir(), '.innies', 'config.json');

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
  try {
    const raw = await readFile(PRIMARY_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const config = buildConfigRecord(parsed);

    if (parsed.version !== 1 || !config) {
      fail(`Invalid config at ${PRIMARY_CONFIG_PATH}. Run: innies login --token <in_token>`);
    }

    // Auto-upgrade provider defaults that were previously hardcoded in an
    // older CLI version (e.g. `claude-opus-4-6` → `claude-opus-4-7`).
    // Rewrites the config to disk so the migration only happens once.
    const migrated = await migrateConfigIfStale(config);
    return migrated;
  } catch (error) {
    if (!required) {
      return null;
    }

    const message = error instanceof Error ? error.message : String(error);
    fail(`Missing or unreadable config (${PRIMARY_CONFIG_PATH}): ${message}`);
  }
}

/**
 * Walk a loaded config, upgrade any provider defaults that match a known
 * previously-hardcoded value to the current default, and persist the
 * result. `defaultModel` is upgraded in lock-step with `providerDefaults.anthropic`
 * so the two stay coherent. Returns the (possibly-migrated) config.
 */
async function migrateConfigIfStale(config) {
  const { providerDefaults: nextProviderDefaults, migrated: providerMigrated } =
    migrateStaleProviderDefaults(config.providerDefaults);

  const defaultModelIsStale = isStaleProviderDefault('anthropic', config.defaultModel);
  const nextDefaultModel = defaultModelIsStale
    ? nextProviderDefaults.anthropic
    : config.defaultModel;

  if (!providerMigrated && !defaultModelIsStale) {
    return config;
  }

  const nextConfig = {
    ...config,
    defaultModel: nextDefaultModel,
    providerDefaults: nextProviderDefaults,
    updatedAt: new Date().toISOString()
  };

  try {
    const file = configPath();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(nextConfig, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Non-fatal: even if we couldn't persist the migration, returning the
    // upgraded config lets this session use the new defaults. Next load
    // will retry the rewrite.
  }

  return nextConfig;
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
