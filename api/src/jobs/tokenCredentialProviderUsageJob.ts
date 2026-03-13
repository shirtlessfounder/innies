import { TokenCredentialRepository } from '../repos/tokenCredentialRepository.js';
import {
  TokenCredentialProviderUsageRepository,
  type TokenCredentialProviderUsageSnapshot
} from '../repos/tokenCredentialProviderUsageRepository.js';
import type { JobDefinition } from './types.js';
import {
  evaluateClaudeContributionCap,
  isAnthropicOauthTokenCredential,
  providerUsageWarningReasonFromRefreshOutcome,
  readTokenCredentialProviderUsagePollMs,
  refreshAnthropicOauthUsageNow
} from '../services/tokenCredentialProviderUsage.js';
import { readClaudeContributionCapSnapshotState } from '../services/claudeContributionCapState.js';

const DEFAULT_RATE_LIMIT_ESCALATION_THRESHOLD = 15;
const DEFAULT_LEGACY_MAXED_RECOVERY_LIMIT = 25;

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

export function createTokenCredentialProviderUsageJob(
  tokenCredentialsRepo: TokenCredentialRepository,
  providerUsageRepo: TokenCredentialProviderUsageRepository
): JobDefinition {
  return {
    name: 'token-credential-provider-usage-minute',
    scheduleMs: readTokenCredentialProviderUsagePollMs(),
    async run(ctx) {
      if (!envFlag('TOKEN_CREDENTIAL_PROVIDER_USAGE_ENABLED', true)) {
        ctx.logger.info('token credential provider usage refresh skipped (disabled)');
        return;
      }

      const escalationThreshold = readIntEnv(
        'TOKEN_CREDENTIAL_RATE_LIMIT_MAX_CONSECUTIVE_FAILURES',
        DEFAULT_RATE_LIMIT_ESCALATION_THRESHOLD
      );
      const credentials = await tokenCredentialsRepo.listActiveOauthByProvider('anthropic');

      let refreshed = 0;
      let failed = 0;
      let deferred = 0;
      let skippedNonOauth = 0;
      let clearedBackoff = 0;

      const syncProviderUsageWarning = async (
        credentialId: string,
        credentialLabel: string | null | undefined,
        result: Awaited<ReturnType<typeof refreshAnthropicOauthUsageNow>>
      ): Promise<void> => {
        try {
          await tokenCredentialsRepo.setProviderUsageWarning(
            credentialId,
            providerUsageWarningReasonFromRefreshOutcome(result)
          );
        } catch (error) {
          ctx.logger.error('token credential provider usage warning sync failed', {
            credentialId,
            credentialLabel: credentialLabel ?? null,
            errorMessage: error instanceof Error ? error.message : 'unknown'
          });
        }
      };

      const syncContributionCapLifecycle = async (
        credential: (typeof credentials)[number],
        snapshot: TokenCredentialProviderUsageSnapshot
      ): Promise<void> => {
        const state = readClaudeContributionCapSnapshotState({ credential, snapshot });
        if (
          !state.inScope
          || state.fetchedAt === null
          || state.fiveHourUtilizationRatio === null
          || state.sevenDayUtilizationRatio === null
          || state.fiveHourSharedThresholdPercent === null
          || state.sevenDaySharedThresholdPercent === null
        ) {
          return;
        }

        try {
          await tokenCredentialsRepo.syncClaudeContributionCapLifecycle({
            id: credential.id,
            orgId: credential.orgId,
            provider: credential.provider,
            snapshotFetchedAt: state.fetchedAt,
            fiveHourReservePercent: state.fiveHourReservePercent,
            fiveHourUtilizationRatio: state.fiveHourUtilizationRatio,
            fiveHourResetsAt: state.fiveHourResetsAt,
            fiveHourSharedThresholdPercent: state.fiveHourSharedThresholdPercent,
            fiveHourContributionCapExhausted: state.fiveHourContributionCapExhausted,
            sevenDayReservePercent: state.sevenDayReservePercent,
            sevenDayUtilizationRatio: state.sevenDayUtilizationRatio,
            sevenDayResetsAt: state.sevenDayResetsAt,
            sevenDaySharedThresholdPercent: state.sevenDaySharedThresholdPercent,
            sevenDayContributionCapExhausted: state.sevenDayContributionCapExhausted
          });
        } catch (error) {
          ctx.logger.error('token credential contribution-cap lifecycle sync failed', {
            credentialId: credential.id,
            credentialLabel: credential.debugLabel ?? null,
            provider: credential.provider,
            errorMessage: error instanceof Error ? error.message : 'unknown'
          });
        }
      };

      for (const credential of credentials) {
        if (!isAnthropicOauthTokenCredential(credential)) {
          skippedNonOauth += 1;
          continue;
        }

        const result = await refreshAnthropicOauthUsageNow(providerUsageRepo, credential);
        await syncProviderUsageWarning(credential.id, credential.debugLabel, result);
        if (!result.ok) {
          if (result.category === 'fetch_backoff') {
            deferred += 1;
            ctx.logger.info('token credential provider usage refresh deferred', {
              credentialId: credential.id,
              credentialLabel: credential.debugLabel ?? null,
              provider: credential.provider,
              reason: result.warningReason ?? result.reason,
              detailReason: result.reason,
              statusCode: result.statusCode,
              retryAfterMs: result.retryAfterMs ?? null
            });
          } else {
            failed += 1;
            ctx.logger.error('token credential provider usage refresh failed', {
              credentialId: credential.id,
              credentialLabel: credential.debugLabel ?? null,
              provider: credential.provider,
              reason: result.warningReason ?? result.reason,
              detailReason: result.reason,
              statusCode: result.statusCode,
              retryAfterMs: result.retryAfterMs ?? null,
              errorMessage: result.errorMessage ?? null
            });
          }
          continue;
        }

        refreshed += 1;
        await syncContributionCapLifecycle(credential, result.snapshot);

        const evaluation = evaluateClaudeContributionCap({
          credential,
          snapshot: result.snapshot,
          now: ctx.now
        });

        if (
          credential.consecutiveRateLimitCount >= escalationThreshold
          && evaluation.inScope
          && evaluation.isFresh
          && evaluation.eligible
        ) {
          const cleared = await tokenCredentialsRepo.clearRateLimitBackoff(credential.id, escalationThreshold);
          if (cleared) {
            clearedBackoff += 1;
          }
        }
      }

      const legacyRecoveryLimit = readIntEnv(
        'TOKEN_CREDENTIAL_PROVIDER_USAGE_LEGACY_MAXED_SCAN_LIMIT',
        DEFAULT_LEGACY_MAXED_RECOVERY_LIMIT
      );
      const legacyMaxedCredentials = await tokenCredentialsRepo.listMaxedForProbe(legacyRecoveryLimit);
      let legacyRecovered = 0;
      let legacyFailed = 0;
      let legacyDeferred = 0;

      for (const credential of legacyMaxedCredentials) {
        const looksLikeLegacyClaudeRateLimitMaxed = isAnthropicOauthTokenCredential(credential)
          && credential.consecutiveRateLimitCount >= escalationThreshold
          && credential.lastFailedStatus !== 401
          && credential.lastFailedStatus !== 403;
        if (!looksLikeLegacyClaudeRateLimitMaxed) {
          continue;
        }

        const result = await refreshAnthropicOauthUsageNow(providerUsageRepo, credential);
        await syncProviderUsageWarning(credential.id, credential.debugLabel, result);
        if (!result.ok) {
          if (result.category === 'fetch_backoff') {
            legacyDeferred += 1;
            ctx.logger.info('legacy Claude maxed recovery deferred', {
              credentialId: credential.id,
              credentialLabel: credential.debugLabel ?? null,
              reason: result.warningReason ?? result.reason,
              detailReason: result.reason,
              statusCode: result.statusCode,
              retryAfterMs: result.retryAfterMs ?? null
            });
          } else {
            legacyFailed += 1;
            ctx.logger.error('legacy Claude maxed recovery failed', {
              credentialId: credential.id,
              credentialLabel: credential.debugLabel ?? null,
              reason: result.warningReason ?? result.reason,
              detailReason: result.reason,
              statusCode: result.statusCode,
              retryAfterMs: result.retryAfterMs ?? null,
              errorMessage: result.errorMessage ?? null
            });
          }
          continue;
        }

        await syncContributionCapLifecycle(credential, result.snapshot);
        const reactivated = await tokenCredentialsRepo.reactivateFromMaxed(credential.id);
        if (reactivated) {
          legacyRecovered += 1;
        }
      }

      ctx.logger.info('token credential provider usage refresh complete', {
        checked: credentials.length,
        refreshed,
        failed,
        deferred,
        skippedNonOauth,
        clearedBackoff,
        legacyMaxedChecked: legacyMaxedCredentials.length,
        legacyRecovered,
        legacyFailed,
        legacyDeferred
      });
    }
  };
}
