const DEFAULT_NEXT_PROMPT_PROVIDER_OVERRIDE_TTL_MS = 5 * 60 * 1000;

type StoredNextPromptProviderOverride = {
  preferredProvider: string;
  armedByRequestId: string;
  expiresAtMs: number;
};

export type NextPromptProviderOverride = {
  preferredProvider: string;
  armedByRequestId: string;
};

const nextPromptProviderOverrides = new Map<string, StoredNextPromptProviderOverride>();

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function readNextPromptProviderOverrideTtlMs(): number {
  return readPositiveIntEnv(
    'NEXT_PROMPT_PROVIDER_OVERRIDE_TTL_MS',
    DEFAULT_NEXT_PROMPT_PROVIDER_OVERRIDE_TTL_MS
  );
}

function normalizeSessionId(value?: string | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildApiKeyScopeKey(apiKeyId: string): string {
  return `api_key:${apiKeyId}`;
}

function buildApiKeySessionScopeKey(apiKeyId: string, sessionId: string): string {
  return `api_key_session:${apiKeyId}:${sessionId}`;
}

function pruneExpiredOverrides(nowMs: number): void {
  for (const [key, value] of nextPromptProviderOverrides.entries()) {
    if (value.expiresAtMs <= nowMs) {
      nextPromptProviderOverrides.delete(key);
    }
  }
}

export function armNextPromptProviderOverride(input: {
  apiKeyId: string;
  openclawSessionId?: string | null;
  preferredProvider: string;
  armedByRequestId: string;
  nowMs?: number;
}): void {
  const nowMs = input.nowMs ?? Date.now();
  pruneExpiredOverrides(nowMs);
  const sessionId = normalizeSessionId(input.openclawSessionId);
  const key = sessionId
    ? buildApiKeySessionScopeKey(input.apiKeyId, sessionId)
    : buildApiKeyScopeKey(input.apiKeyId);

  nextPromptProviderOverrides.set(key, {
    preferredProvider: input.preferredProvider,
    armedByRequestId: input.armedByRequestId,
    expiresAtMs: nowMs + readNextPromptProviderOverrideTtlMs()
  });
}

export function consumeNextPromptProviderOverride(input: {
  apiKeyId: string;
  openclawSessionId?: string | null;
  nowMs?: number;
}): NextPromptProviderOverride | null {
  const nowMs = input.nowMs ?? Date.now();
  pruneExpiredOverrides(nowMs);

  const sessionId = normalizeSessionId(input.openclawSessionId);
  const candidateKeys = sessionId
    ? [
        buildApiKeySessionScopeKey(input.apiKeyId, sessionId),
        buildApiKeyScopeKey(input.apiKeyId)
      ]
    : [buildApiKeyScopeKey(input.apiKeyId)];

  for (const key of candidateKeys) {
    const override = nextPromptProviderOverrides.get(key);
    if (!override) continue;
    nextPromptProviderOverrides.delete(key);
    return {
      preferredProvider: override.preferredProvider,
      armedByRequestId: override.armedByRequestId
    };
  }

  return null;
}

export function resetNextPromptProviderOverridesForTests(): void {
  nextPromptProviderOverrides.clear();
}
