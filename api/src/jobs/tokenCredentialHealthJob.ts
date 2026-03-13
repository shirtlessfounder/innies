import { TokenCredentialRepository } from '../repos/tokenCredentialRepository.js';
import type { JobDefinition } from './types.js';
import {
  probeAndUpdateTokenCredential,
  readTokenCredentialProbeIntervalMinutes,
  readTokenCredentialProbeTimeoutMs
} from '../services/tokenCredentialProbe.js';
import { isAnthropicOauthTokenCredential } from '../services/tokenCredentialProviderUsage.js';

const DEFAULT_SCHEDULE_MS = 10 * 60 * 1000;

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

export function createTokenCredentialHealthJob(repo: TokenCredentialRepository): JobDefinition {
  return {
    name: 'token-credential-healthcheck-hourly',
    scheduleMs: readIntEnv('TOKEN_CREDENTIAL_PROBE_SCHEDULE_MS', DEFAULT_SCHEDULE_MS),
    async run(ctx) {
      if (!envFlag('TOKEN_CREDENTIAL_PROBE_ENABLED', true)) {
        ctx.logger.info('token credential healthcheck skipped (disabled)');
        return;
      }

      const maxKeys = readIntEnv('TOKEN_CREDENTIAL_PROBE_MAX_KEYS', 20);
      const timeoutMs = readTokenCredentialProbeTimeoutMs();
      const probeIntervalMinutes = readTokenCredentialProbeIntervalMinutes();
      const candidates = (await repo.listMaxedForProbe(maxKeys * 5))
        .filter((credential) => !isAnthropicOauthTokenCredential(credential))
        .slice(0, maxKeys);

      let reactivated = 0;
      let stillMaxed = 0;

      for (const credential of candidates) {
        const result = await probeAndUpdateTokenCredential(repo, credential, {
          timeoutMs,
          probeIntervalMinutes
        });
        if (result.reactivated) {
            reactivated += 1;
            ctx.logger.info('token credential reactivated', {
              credentialId: credential.id,
              credentialLabel: credential.debugLabel ?? null,
              provider: credential.provider
            });
          continue;
        }

        stillMaxed += 1;
      }

      ctx.logger.info('token credential healthcheck complete', {
        checked: candidates.length,
        reactivated,
        stillMaxed
      });
    }
  };
}
