import { SellerKeyRepository } from '../repos/sellerKeyRepository.js';
import type { JobDefinition } from './types.js';

const FIVE_MIN_MS = 5 * 60 * 1000;

type HealthCheckResult = {
  ok: boolean;
  keySpecificFailure: boolean;
  reason?: string;
};

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function providerBaseUrl(provider: string): string | null {
  if (provider === 'anthropic') {
    return process.env.ANTHROPIC_UPSTREAM_BASE_URL || 'https://api.anthropic.com';
  }

  return null;
}

async function checkProviderKey(provider: string, secret: string, timeoutMs: number): Promise<HealthCheckResult> {
  const baseUrl = providerBaseUrl(provider);
  if (!baseUrl) {
    return { ok: false, keySpecificFailure: false, reason: `unsupported_provider:${provider}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL('/v1/models', baseUrl), {
      method: 'GET',
      headers: {
        'x-api-key': secret,
        'anthropic-version': '2023-06-01'
      },
      signal: controller.signal
    });

    if (response.ok) return { ok: true, keySpecificFailure: false };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, keySpecificFailure: true, reason: `auth_${response.status}` };
    }

    return { ok: false, keySpecificFailure: false, reason: `status_${response.status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'healthcheck_error';
    return { ok: false, keySpecificFailure: false, reason: `network:${message}` };
  } finally {
    clearTimeout(timer);
  }
}

export function createKeyHealthCheckJob(repo: SellerKeyRepository): JobDefinition {
  return {
    name: 'seller-key-healthcheck-5m',
    scheduleMs: FIVE_MIN_MS,
    async run(ctx) {
      const enabled = envFlag('KEY_HEALTHCHECK_ENABLED', true);
      if (!enabled) {
        ctx.logger.info('seller key healthcheck skipped (disabled)');
        return;
      }

      const maxKeys = readIntEnv('KEY_HEALTHCHECK_MAX_KEYS', 20);
      const timeoutMs = readIntEnv('KEY_HEALTHCHECK_TIMEOUT_MS', 5000);
      const quarantineThreshold = readIntEnv('KEY_HEALTHCHECK_QUARANTINE_THRESHOLD', 3);
      const candidates = await repo.listHealthCheckCandidates(maxKeys);

      let okCount = 0;
      let failCount = 0;
      let quarantinedCount = 0;

      for (const candidate of candidates) {
        const sellerKey = await repo.getSecret(candidate.id);
        if (!sellerKey) {
          const marked = await repo.markHealthCheckFailure(candidate.id, quarantineThreshold);
          failCount += 1;
          if (marked?.status === 'quarantined') quarantinedCount += 1;
          continue;
        }

        const check = await checkProviderKey(candidate.provider, sellerKey.secret, timeoutMs);
        if (check.ok) {
          await repo.markHealthCheckSuccess(candidate.id);
          okCount += 1;
          continue;
        }

        if (!check.keySpecificFailure) {
          ctx.logger.info('seller key healthcheck non-key-specific failure', {
            sellerKeyId: candidate.id,
            provider: candidate.provider,
            reason: check.reason ?? 'unknown'
          });
          continue;
        }

        const marked = await repo.markHealthCheckFailure(candidate.id, quarantineThreshold);
        failCount += 1;
        if (marked?.status === 'quarantined') quarantinedCount += 1;
      }

      ctx.logger.info('seller key healthcheck complete', {
        checked: candidates.length,
        okCount,
        failCount,
        quarantinedCount
      });
    }
  };
}
