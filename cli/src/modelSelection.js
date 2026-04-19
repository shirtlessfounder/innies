const DEFAULT_MODELS = Object.freeze({
  anthropic: 'claude-opus-4-7',
  openai: 'gpt-5.4'
});

const LEGACY_DEFAULT_MODEL = DEFAULT_MODELS.anthropic;
const LEGACY_DEFAULT_MODEL_SENTINELS = new Set(['innies/default']);

// Provider-default values that were previously hardcoded in older CLI
// versions. When `loadConfig` encounters one of these, it's assumed to
// have been auto-saved by `innies login` against an older release rather
// than an explicit user pick — so we transparently upgrade it to the
// current default (DEFAULT_MODELS[provider]). This lets `npm install -g
// innies@latest` actually surface new defaults to existing users.
const STALE_PROVIDER_DEFAULTS = Object.freeze({
  anthropic: new Set([
    'claude-opus-4-6'
  ]),
  openai: new Set([])
});

export function defaultProviderModels() {
  return { ...DEFAULT_MODELS };
}

export function defaultAnthropicModel() {
  return LEGACY_DEFAULT_MODEL;
}

export function defaultOpenAiModel() {
  return DEFAULT_MODELS.openai;
}

export function normalizeModel(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeLegacyFallbackModel(value) {
  const normalized = normalizeModel(value);
  if (!normalized) return null;
  return LEGACY_DEFAULT_MODEL_SENTINELS.has(normalized.toLowerCase()) ? null : normalized;
}

export function inferModelProvider(value) {
  const normalized = normalizeModel(value);
  if (!normalized) return null;
  const lower = normalized.toLowerCase();

  if (
    lower.startsWith('claude')
    || lower.includes('sonnet')
    || lower.includes('opus')
    || lower.includes('haiku')
  ) {
    return 'anthropic';
  }

  if (
    lower.startsWith('gpt-')
    || lower.startsWith('o1')
    || lower.startsWith('o3')
    || lower.startsWith('o4')
    || lower.startsWith('codex-')
  ) {
    return 'openai';
  }

  return null;
}

// Unknown model ids are preserved as fallback metadata but do not rewrite lane defaults.
export function providerDefaultsFromModelHint(value) {
  const defaults = defaultProviderModels();
  const normalized = normalizeLegacyFallbackModel(value) ?? normalizeModel(value);
  if (!normalized) {
    return defaults;
  }

  const provider = inferModelProvider(normalized);
  if (!provider) {
    return defaults;
  }

  defaults[provider] = normalized;
  return defaults;
}

export function normalizeProviderDefaults(raw, fallbackModel) {
  const providerDefaults = raw && typeof raw === 'object'
    ? raw
    : {};
  const defaults = providerDefaultsFromModelHint(fallbackModel);
  return {
    anthropic: normalizeLegacyFallbackModel(providerDefaults.anthropic) ?? defaults.anthropic,
    openai: normalizeLegacyFallbackModel(providerDefaults.openai) ?? defaults.openai
  };
}

/**
 * Return true when `value` matches a previously-hardcoded provider
 * default that older CLI versions auto-saved into the config. Used by
 * loadConfig to distinguish "was auto-saved by older CLI" from "user
 * explicitly picked this model".
 */
export function isStaleProviderDefault(provider, value) {
  const normalized = normalizeModel(value);
  if (!normalized) return false;
  const staleSet = STALE_PROVIDER_DEFAULTS[provider];
  return staleSet ? staleSet.has(normalized) : false;
}

/**
 * Upgrade a providerDefaults map by replacing stale entries with the
 * current hardcoded defaults. Returns `{ providerDefaults, migrated }`
 * where `migrated` is true if anything changed.
 */
export function migrateStaleProviderDefaults(providerDefaults) {
  const next = { ...providerDefaults };
  let migrated = false;

  for (const provider of Object.keys(DEFAULT_MODELS)) {
    if (isStaleProviderDefault(provider, next[provider])) {
      next[provider] = DEFAULT_MODELS[provider];
      migrated = true;
    }
  }

  return { providerDefaults: next, migrated };
}
