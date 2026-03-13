import type { TokenCredential } from '../repos/tokenCredentialRepository.js';
import type { TokenCredentialProviderUsageSnapshot } from '../repos/tokenCredentialProviderUsageRepository.js';

export type ClaudeContributionCapSnapshotState = {
  inScope: boolean;
  fiveHourReservePercent: number;
  sevenDayReservePercent: number;
  fiveHourUtilizationRatio: number | null;
  fiveHourResetsAt: Date | null;
  fiveHourSharedThresholdPercent: number | null;
  fiveHourContributionCapExhausted: boolean;
  sevenDayUtilizationRatio: number | null;
  sevenDayResetsAt: Date | null;
  sevenDaySharedThresholdPercent: number | null;
  sevenDayContributionCapExhausted: boolean;
  fetchedAt: Date | null;
};

export type ClaudeProviderUsageExhaustionHoldState = {
  fiveHourProviderUsageExhausted: boolean;
  fiveHourHoldActive: boolean;
  sevenDayProviderUsageExhausted: boolean;
  sevenDayHoldActive: boolean;
  hasActiveHold: boolean;
  nextRefreshAt: Date | null;
  reason: 'usage_exhausted_5h' | 'usage_exhausted_7d' | null;
};

function isAnthropicOauthTokenCredentialLike(
  credential: Pick<TokenCredential, 'provider' | 'accessToken'>
): boolean {
  return credential.provider === 'anthropic' && credential.accessToken.includes('sk-ant-oat');
}

function isProviderUsageExhausted(utilizationRatio: number | null): boolean {
  return utilizationRatio !== null && utilizationRatio >= 1;
}

export function readClaudeProviderUsageExhaustionHoldState(input: {
  fiveHourUtilizationRatio: number | null;
  fiveHourResetsAt: Date | null;
  sevenDayUtilizationRatio: number | null;
  sevenDayResetsAt: Date | null;
  now?: Date;
}): ClaudeProviderUsageExhaustionHoldState {
  const nowMs = (input.now ?? new Date()).getTime();
  const fiveHourProviderUsageExhausted = isProviderUsageExhausted(input.fiveHourUtilizationRatio);
  const sevenDayProviderUsageExhausted = isProviderUsageExhausted(input.sevenDayUtilizationRatio);
  const fiveHourHoldActive = fiveHourProviderUsageExhausted
    && input.fiveHourResetsAt !== null
    && input.fiveHourResetsAt.getTime() > nowMs;
  const sevenDayHoldActive = sevenDayProviderUsageExhausted
    && input.sevenDayResetsAt !== null
    && input.sevenDayResetsAt.getTime() > nowMs;
  const nextRefreshAt = [
    fiveHourHoldActive ? input.fiveHourResetsAt : null,
    sevenDayHoldActive ? input.sevenDayResetsAt : null
  ]
    .filter((value): value is Date => value !== null)
    .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;

  return {
    fiveHourProviderUsageExhausted,
    fiveHourHoldActive,
    sevenDayProviderUsageExhausted,
    sevenDayHoldActive,
    hasActiveHold: fiveHourHoldActive || sevenDayHoldActive,
    nextRefreshAt,
    reason: fiveHourHoldActive
      ? 'usage_exhausted_5h'
      : sevenDayHoldActive
        ? 'usage_exhausted_7d'
        : null
  };
}

export function readClaudeContributionCapSnapshotState(input: {
  credential: TokenCredential;
  snapshot: TokenCredentialProviderUsageSnapshot | null;
}): ClaudeContributionCapSnapshotState {
  const { credential, snapshot } = input;
  const fiveHourReservePercent = credential.fiveHourReservePercent ?? 0;
  const sevenDayReservePercent = credential.sevenDayReservePercent ?? 0;
  const inScope = isAnthropicOauthTokenCredentialLike(credential);
  const fiveHourSharedThresholdPercent = inScope ? (100 - fiveHourReservePercent) : null;
  const sevenDaySharedThresholdPercent = inScope ? (100 - sevenDayReservePercent) : null;

  if (!inScope || !snapshot) {
    return {
      inScope,
      fiveHourReservePercent,
      sevenDayReservePercent,
      fiveHourUtilizationRatio: null,
      fiveHourResetsAt: null,
      fiveHourSharedThresholdPercent,
      fiveHourContributionCapExhausted: false,
      sevenDayUtilizationRatio: null,
      sevenDayResetsAt: null,
      sevenDaySharedThresholdPercent,
      sevenDayContributionCapExhausted: false,
      fetchedAt: null
    };
  }

  const fiveHourUtilizationPercent = snapshot.fiveHourUtilizationRatio * 100;
  const sevenDayUtilizationPercent = snapshot.sevenDayUtilizationRatio * 100;

  return {
    inScope,
    fiveHourReservePercent,
    sevenDayReservePercent,
    fiveHourUtilizationRatio: snapshot.fiveHourUtilizationRatio,
    fiveHourResetsAt: snapshot.fiveHourResetsAt,
    fiveHourSharedThresholdPercent,
    fiveHourContributionCapExhausted: fiveHourSharedThresholdPercent !== null
      && fiveHourUtilizationPercent >= fiveHourSharedThresholdPercent,
    sevenDayUtilizationRatio: snapshot.sevenDayUtilizationRatio,
    sevenDayResetsAt: snapshot.sevenDayResetsAt,
    sevenDaySharedThresholdPercent,
    sevenDayContributionCapExhausted: sevenDaySharedThresholdPercent !== null
      && sevenDayUtilizationPercent >= sevenDaySharedThresholdPercent,
    fetchedAt: snapshot.fetchedAt
  };
}

export function readClaudeContributionCapProviderExhaustionHold(input: {
  credential: TokenCredential;
  snapshot: TokenCredentialProviderUsageSnapshot | null;
  now?: Date;
}): ClaudeProviderUsageExhaustionHoldState {
  const state = readClaudeContributionCapSnapshotState(input);
  return readClaudeProviderUsageExhaustionHoldState({
    fiveHourUtilizationRatio: state.fiveHourUtilizationRatio,
    fiveHourResetsAt: state.fiveHourResetsAt,
    sevenDayUtilizationRatio: state.sevenDayUtilizationRatio,
    sevenDayResetsAt: state.sevenDayResetsAt,
    now: input.now
  });
}
