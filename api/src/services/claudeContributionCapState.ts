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

function isAnthropicOauthTokenCredentialLike(
  credential: Pick<TokenCredential, 'provider' | 'accessToken'>
): boolean {
  return credential.provider === 'anthropic' && credential.accessToken.includes('sk-ant-oat');
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
