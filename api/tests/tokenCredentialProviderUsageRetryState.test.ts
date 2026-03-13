import { afterEach, describe, expect, it } from 'vitest';
import {
  getAnthropicUsageRetryBackoff,
  markAnthropicUsageRefreshFailure,
  resetAnthropicUsageRetryStateForTests
} from '../src/services/tokenCredentialProviderUsageRetryState.js';

describe('tokenCredentialProviderUsageRetryState', () => {
  afterEach(() => {
    resetAnthropicUsageRetryStateForTests();
    delete process.env.TOKEN_CREDENTIAL_PROVIDER_USAGE_RETRY_BASE_MS;
    delete process.env.TOKEN_CREDENTIAL_PROVIDER_USAGE_RETRY_MAX_MS;
  });

  it('caps the default provider-usage retry backoff at 5 minutes', () => {
    const credentialId = 'cred_retry_cap';
    const nowMs = 1_000_000;

    expect(markAnthropicUsageRefreshFailure(credentialId, 'status_429', 429, nowMs).retryAfterMs).toBe(2 * 60 * 1000);
    expect(markAnthropicUsageRefreshFailure(credentialId, 'status_429', 429, nowMs).retryAfterMs).toBe(4 * 60 * 1000);
    expect(markAnthropicUsageRefreshFailure(credentialId, 'status_429', 429, nowMs).retryAfterMs).toBe(5 * 60 * 1000);
    expect(markAnthropicUsageRefreshFailure(credentialId, 'status_429', 429, nowMs).retryAfterMs).toBe(5 * 60 * 1000);

    const backoff = getAnthropicUsageRetryBackoff(credentialId, nowMs);
    expect(backoff).toMatchObject({
      consecutiveFailures: 4,
      retryAfterMs: 5 * 60 * 1000,
      lastFailureReason: 'status_429',
      lastStatusCode: 429
    });
  });
});
