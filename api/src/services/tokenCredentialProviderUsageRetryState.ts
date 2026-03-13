const DEFAULT_PROVIDER_USAGE_RETRY_BASE_MS = 2 * 60 * 1000;
const DEFAULT_PROVIDER_USAGE_RETRY_MAX_MS = 5 * 60 * 1000;
const MAX_RETRY_EXPONENT = 4;

type AnthropicUsageRetryState = {
  consecutiveFailures: number;
  nextAllowedAtMs: number;
  lastFailureReason: string;
  lastStatusCode: number | null;
};

export type AnthropicUsageRetryBackoff = {
  consecutiveFailures: number;
  retryAfterMs: number;
  lastFailureReason: string;
  lastStatusCode: number | null;
};

const anthropicUsageRetryStates = new Map<string, AnthropicUsageRetryState>();

function readIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function readProviderUsageRetryBaseMs(): number {
  return readIntEnv('TOKEN_CREDENTIAL_PROVIDER_USAGE_RETRY_BASE_MS', DEFAULT_PROVIDER_USAGE_RETRY_BASE_MS);
}

function readProviderUsageRetryMaxMs(): number {
  return readIntEnv('TOKEN_CREDENTIAL_PROVIDER_USAGE_RETRY_MAX_MS', DEFAULT_PROVIDER_USAGE_RETRY_MAX_MS);
}

export function getAnthropicUsageRetryBackoff(
  credentialId: string,
  nowMs = Date.now()
): AnthropicUsageRetryBackoff | null {
  const state = anthropicUsageRetryStates.get(credentialId);
  if (!state) return null;

  const retryAfterMs = state.nextAllowedAtMs - nowMs;
  if (retryAfterMs <= 0) return null;

  return {
    consecutiveFailures: state.consecutiveFailures,
    retryAfterMs,
    lastFailureReason: state.lastFailureReason,
    lastStatusCode: state.lastStatusCode
  };
}

export function markAnthropicUsageRefreshFailure(
  credentialId: string,
  reason: string,
  statusCode: number | null,
  nowMs = Date.now()
): AnthropicUsageRetryBackoff {
  const previous = anthropicUsageRetryStates.get(credentialId);
  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
  const delayMs = Math.min(
    readProviderUsageRetryMaxMs(),
    readProviderUsageRetryBaseMs() * (2 ** Math.min(MAX_RETRY_EXPONENT, consecutiveFailures - 1))
  );
  const nextAllowedAtMs = nowMs + delayMs;

  anthropicUsageRetryStates.set(credentialId, {
    consecutiveFailures,
    nextAllowedAtMs,
    lastFailureReason: reason,
    lastStatusCode: statusCode
  });

  return {
    consecutiveFailures,
    retryAfterMs: delayMs,
    lastFailureReason: reason,
    lastStatusCode: statusCode
  };
}

export function clearAnthropicUsageRefreshFailure(credentialId: string): void {
  anthropicUsageRetryStates.delete(credentialId);
}

export function resetAnthropicUsageRetryStateForTests(): void {
  anthropicUsageRetryStates.clear();
}
