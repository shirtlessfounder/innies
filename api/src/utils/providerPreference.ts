import type { ProviderPreference } from '../repos/apiKeyRepository.js';

export function resolveDefaultBuyerProvider(): ProviderPreference {
  const raw = String(process.env.BUYER_PROVIDER_PREFERENCE_DEFAULT || 'anthropic')
    .trim()
    .toLowerCase();
  if (raw === 'openai' || raw === 'codex') return 'openai';
  return 'anthropic';
}
