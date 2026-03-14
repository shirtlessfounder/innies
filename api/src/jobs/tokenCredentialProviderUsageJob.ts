import { TokenCredentialRepository } from '../repos/tokenCredentialRepository.js';
import {
  TokenCredentialProviderUsageRepository,
  type TokenCredentialProviderUsageSnapshot
} from '../repos/tokenCredentialProviderUsageRepository.js';
import type { JobDefinition } from './types.js';
import {
  type AnthropicOauthUsageRefreshOutcome,
  anthropicOauthUsageAuthFailureStatusCode,
  evaluateClaudeContributionCap,
  isAnthropicOauthTokenCredential,
  parkAnthropicOauthCredentialAfterUsageAuthFailure,
  providerUsageWarningReasonFromRefreshOutcome,
  readTokenCredentialProviderUsagePollMs,
} from '../services/tokenCredentialProviderUsage.js';
import { refreshAnthropicOauthUsageWithCredentialRefresh } from '../services/tokenCredentialOauthRefresh.js';
import { evaluateClaudeCredentialAvailability } from '../services/claudeCredentialAvailability.js';
import {
  readClaudeContributionCapProviderExhaustionHold,
  readClaudeContributionCapSnapshotState
} from '../services/claudeContributionCapState.js';
import {
  probeAndUpdateTokenCredential,
  readTokenCredentialProbeIntervalMinutes,
  readTokenCredentialProbeTimeoutMs
} from '../services/tokenCredentialProbe.js';

const DEFAULT_RATE_LIMIT_ESCALATION_THRESHOLD = 10;
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
        'TOKEN_CREDENTIAL_RATE_LIMIT_CONSECUTIVE_FAILURES',
        DEFAULT_RATE_LIMIT_ESCALATION_THRESHOLD
      );
      const probeTimeoutMs = readTokenCredentialProbeTimeoutMs();
      const probeIntervalMinutes = readTokenCredentialProbeIntervalMinutes();
      const credentials = await tokenCredentialsRepo.listActiveOauthByProvider('anthropic');
      const existingSnapshots = typeof (providerUsageRepo as {
        listByTokenCredentialIds?: (ids: string[]) => Promise<TokenCredentialProviderUsageSnapshot[]>;
      }).listByTokenCredentialIds === 'function'
        ? await providerUsageRepo.listByTokenCredentialIds(credentials.map((credential) => credential.id))
        : [];
      const existingSnapshotsByCredentialId = new Map(
        existingSnapshots.map((snapshot) => [snapshot.tokenCredentialId, snapshot])
      );

      let refreshed = 0;
      let failed = 0;
      let deferred = 0;
      let paused = 0;
      let skippedNonOauth = 0;
      let clearedBackoff = 0;
      let authProbeChecked = 0;
      let authProbeReactivated = 0;
      let authProbeDeferred = 0;
      let authRefreshParked = 0;

      const syncProviderUsageWarning = async (
        credentialId: string,
        credentialLabel: string | null | undefined,
        result: AnthropicOauthUsageRefreshOutcome
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

        const providerExhaustionHold = readClaudeContributionCapProviderExhaustionHold({
          credential,
          snapshot: existingSnapshotsByCredentialId.get(credential.id) ?? null,
          now: ctx.now
        });
        if (providerExhaustionHold.hasActiveHold && providerExhaustionHold.nextRefreshAt) {
          paused += 1;
          await tokenCredentialsRepo.setProviderUsageWarning(credential.id, null);
          ctx.logger.info('token credential provider usage refresh paused (provider exhausted)', {
            credentialId: credential.id,
            credentialLabel: credential.debugLabel ?? null,
            provider: credential.provider,
            reason: providerExhaustionHold.reason,
            nextRefreshAt: providerExhaustionHold.nextRefreshAt.toISOString()
          });
          continue;
        }

        const refreshedUsage = await refreshAnthropicOauthUsageWithCredentialRefresh(
          providerUsageRepo,
          tokenCredentialsRepo,
          credential
        );
        const credentialForUsage = refreshedUsage.credential;
        const result = refreshedUsage.outcome;
        const authFailureStatusCode = anthropicOauthUsageAuthFailureStatusCode(result);
        if (authFailureStatusCode !== null) {
          const nextProbeAt = new Date(ctx.now.getTime() + (probeIntervalMinutes * 60 * 1000));
          await parkAnthropicOauthCredentialAfterUsageAuthFailure(tokenCredentialsRepo, credentialForUsage, {
            statusCode: authFailureStatusCode,
            nextProbeAt,
            reason: `upstream_${authFailureStatusCode}_provider_usage_refresh`
          });
          authRefreshParked += 1;
          ctx.logger.info('token credential provider usage auth failure parked', {
            credentialId: credentialForUsage.id,
            credentialLabel: credentialForUsage.debugLabel ?? null,
            provider: credentialForUsage.provider,
            statusCode: authFailureStatusCode,
            nextProbeAt: nextProbeAt.toISOString(),
            detailReason: result.ok ? null : result.reason
          });
          continue;
        }
        await syncProviderUsageWarning(credentialForUsage.id, credentialForUsage.debugLabel, result);
        if (!result.ok) {
          if (result.category === 'fetch_backoff') {
            deferred += 1;
            ctx.logger.info('token credential provider usage refresh deferred', {
              credentialId: credentialForUsage.id,
              credentialLabel: credentialForUsage.debugLabel ?? null,
              provider: credentialForUsage.provider,
              reason: result.warningReason ?? result.reason,
              detailReason: result.reason,
              statusCode: result.statusCode,
              retryAfterMs: result.retryAfterMs ?? null
            });
          } else {
            failed += 1;
            ctx.logger.error('token credential provider usage refresh failed', {
              credentialId: credentialForUsage.id,
              credentialLabel: credentialForUsage.debugLabel ?? null,
              provider: credentialForUsage.provider,
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
        await syncContributionCapLifecycle(credentialForUsage, result.snapshot);

        const evaluation = evaluateClaudeContributionCap({
          credential: credentialForUsage,
          snapshot: result.snapshot,
          now: ctx.now
        });

        if (
          credentialForUsage.consecutiveRateLimitCount >= escalationThreshold
          && evaluation.inScope
          && evaluation.isFresh
          && evaluation.eligible
        ) {
          const cleared = await tokenCredentialsRepo.clearRateLimitBackoff(credentialForUsage.id, escalationThreshold);
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
      let legacyMaxedChecked = 0;
      let legacyRecovered = 0;
      let legacyFailed = 0;
      let legacyDeferred = 0;

      for (const credential of legacyMaxedCredentials) {
        const availability = evaluateClaudeCredentialAvailability({
          credential,
          snapshot: null,
          now: ctx.now,
          rateLimitThreshold: escalationThreshold
        });

        if (availability.authFailed) {
          authProbeChecked += 1;
          const result = await probeAndUpdateTokenCredential(tokenCredentialsRepo, credential, {
            timeoutMs: probeTimeoutMs,
            probeIntervalMinutes
          });
          if (result.reactivated) {
            authProbeReactivated += 1;
            ctx.logger.info('Claude auth recovery reactivated', {
              credentialId: credential.id,
              credentialLabel: credential.debugLabel ?? null,
              statusCode: result.statusCode,
              reason: result.reason
            });
          } else {
            authProbeDeferred += 1;
            ctx.logger.info('Claude auth recovery deferred', {
              credentialId: credential.id,
              credentialLabel: credential.debugLabel ?? null,
              statusCode: result.statusCode,
              reason: result.reason,
              nextProbeAt: result.nextProbeAt?.toISOString() ?? null
            });
          }
          continue;
        }

        const looksLikeLegacyClaudeRateLimitMaxed = isAnthropicOauthTokenCredential(credential)
          && credential.consecutiveRateLimitCount >= escalationThreshold
          && credential.lastFailedStatus !== 401
          && credential.lastFailedStatus !== 403;
        if (!looksLikeLegacyClaudeRateLimitMaxed) {
          continue;
        }
        legacyMaxedChecked += 1;

        const refreshedUsage = await refreshAnthropicOauthUsageWithCredentialRefresh(
          providerUsageRepo,
          tokenCredentialsRepo,
          credential
        );
        const credentialForUsage = refreshedUsage.credential;
        const result = refreshedUsage.outcome;
        const authFailureStatusCode = anthropicOauthUsageAuthFailureStatusCode(result);
        if (authFailureStatusCode !== null) {
          const nextProbeAt = new Date(ctx.now.getTime() + (probeIntervalMinutes * 60 * 1000));
          await parkAnthropicOauthCredentialAfterUsageAuthFailure(tokenCredentialsRepo, credentialForUsage, {
            statusCode: authFailureStatusCode,
            nextProbeAt,
            reason: `upstream_${authFailureStatusCode}_provider_usage_refresh`
          });
          authProbeDeferred += 1;
          ctx.logger.info('legacy Claude maxed auth failure parked', {
            credentialId: credentialForUsage.id,
            credentialLabel: credentialForUsage.debugLabel ?? null,
            statusCode: authFailureStatusCode,
            nextProbeAt: nextProbeAt.toISOString(),
            detailReason: result.ok ? null : result.reason
          });
          continue;
        }
        await syncProviderUsageWarning(credentialForUsage.id, credentialForUsage.debugLabel, result);
        if (!result.ok) {
          if (result.category === 'fetch_backoff') {
            legacyDeferred += 1;
            ctx.logger.info('legacy Claude maxed recovery deferred', {
              credentialId: credentialForUsage.id,
              credentialLabel: credentialForUsage.debugLabel ?? null,
              reason: result.warningReason ?? result.reason,
              detailReason: result.reason,
              statusCode: result.statusCode,
              retryAfterMs: result.retryAfterMs ?? null
            });
          } else {
            legacyFailed += 1;
            ctx.logger.error('legacy Claude maxed recovery failed', {
              credentialId: credentialForUsage.id,
              credentialLabel: credentialForUsage.debugLabel ?? null,
              reason: result.warningReason ?? result.reason,
              detailReason: result.reason,
              statusCode: result.statusCode,
              retryAfterMs: result.retryAfterMs ?? null,
              errorMessage: result.errorMessage ?? null
            });
          }
          continue;
        }

        await syncContributionCapLifecycle(credentialForUsage, result.snapshot);
        const providerExhaustionHold = readClaudeContributionCapProviderExhaustionHold({
          credential: credentialForUsage,
          snapshot: result.snapshot,
          now: ctx.now
        });
        if (providerExhaustionHold.hasActiveHold && providerExhaustionHold.nextRefreshAt) {
          const parked = await tokenCredentialsRepo.markProbeFailure(
            credentialForUsage.id,
            providerExhaustionHold.nextRefreshAt,
            providerExhaustionHold.reason ?? 'provider_usage_exhausted'
          );
          if (parked) {
            legacyDeferred += 1;
            ctx.logger.info('legacy Claude maxed recovery deferred', {
              credentialId: credentialForUsage.id,
              credentialLabel: credentialForUsage.debugLabel ?? null,
              reason: providerExhaustionHold.reason,
              detailReason: providerExhaustionHold.reason,
              nextProbeAt: providerExhaustionHold.nextRefreshAt.toISOString(),
              retryAfterMs: Math.max(0, providerExhaustionHold.nextRefreshAt.getTime() - ctx.now.getTime())
            });
            continue;
          }

          legacyFailed += 1;
          ctx.logger.error('legacy Claude maxed recovery failed', {
            credentialId: credential.id,
            credentialLabel: credential.debugLabel ?? null,
            reason: providerExhaustionHold.reason,
            detailReason: 'failed_to_schedule_next_probe_at_reset',
            statusCode: null,
            retryAfterMs: Math.max(0, providerExhaustionHold.nextRefreshAt.getTime() - ctx.now.getTime()),
            errorMessage: 'failed to defer legacy Claude maxed recovery until provider reset'
          });
          continue;
        }

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
        paused,
        skippedNonOauth,
        clearedBackoff,
        authProbeChecked,
        authProbeReactivated,
        authProbeDeferred,
        authRefreshParked,
        legacyMaxedChecked,
        legacyRecovered,
        legacyFailed,
        legacyDeferred
      });
    }
  };
}
