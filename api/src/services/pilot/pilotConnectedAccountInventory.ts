import type { TokenCredential } from '../../repos/tokenCredentialRepository.js';
import type { TokenCredentialProviderUsageSnapshot } from '../../repos/tokenCredentialProviderUsageRepository.js';
import { deriveDashboardTokenStatusRow } from '../dashboardTokenStatus.js';
import { deriveTokenCredentialAuthDiagnosis } from '../tokenCredentialAuthDiagnosis.js';
import {
  evaluateClaudeContributionCap,
  isTokenCredentialProviderUsageRefreshSupported,
  readTokenCredentialProviderUsageHardStaleMs,
  readTokenCredentialProviderUsageSoftStaleMs
} from '../tokenCredentialProviderUsage.js';
import { readClaudeContributionCapSnapshotState } from '../claudeContributionCapState.js';

export type ConnectedAccountProviderUsageState =
  | 'unsupported'
  | 'missing'
  | 'fresh'
  | 'soft_stale'
  | 'hard_stale';

export type ConnectedAccountInventoryRow = {
  credentialId: string;
  orgId: string;
  provider: string;
  debugLabel: string | null;
  status: string;
  rawStatus: string;
  expandedStatus: string;
  statusSource: string | null;
  exclusionReason: string | null;
  authDiagnosis: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenState: 'missing' | 'present' | null;
  expiresAt: string;
  rateLimitedUntil: string | null;
  nextProbeAt: string | null;
  fiveHourReservePercent: number;
  sevenDayReservePercent: number;
  providerUsageRefreshSupported: boolean;
  providerUsageSource: string | null;
  providerUsageFetchedAt: string | null;
  providerUsageState: ConnectedAccountProviderUsageState;
  providerUsageWarning: string | null;
  fiveHourUtilizationRatio: number | null;
  fiveHourResetsAt: string | null;
  fiveHourContributionCapExhausted: boolean | null;
  fiveHourUsageExhausted: boolean | null;
  sevenDayUtilizationRatio: number | null;
  sevenDayResetsAt: string | null;
  sevenDayContributionCapExhausted: boolean | null;
  sevenDayUsageExhausted: boolean | null;
};

export function buildConnectedAccountInventory(input: {
  credentials: TokenCredential[];
  snapshots: TokenCredentialProviderUsageSnapshot[];
  now?: Date;
}): ConnectedAccountInventoryRow[] {
  const now = input.now ?? new Date();
  const snapshotsByCredentialId = new Map(
    input.snapshots.map((snapshot) => [snapshot.tokenCredentialId, snapshot] as const)
  );

  return input.credentials.map((credential) => {
    const snapshot = snapshotsByCredentialId.get(credential.id) ?? null;
    const providerUsageRefreshSupported = isTokenCredentialProviderUsageRefreshSupported(credential);
    const providerUsageState = deriveProviderUsageState({
      snapshot,
      supported: providerUsageRefreshSupported,
      now
    });
    const auth = deriveTokenCredentialAuthDiagnosis({
      provider: credential.provider,
      accessToken: credential.accessToken,
      hasRefreshToken: credential.refreshToken !== null,
      lastFailedStatus: credential.lastFailedStatus,
      now
    });
    const normalizedStatusProvider = credential.provider === 'codex' ? 'openai' : credential.provider;

    const claudeState = normalizedStatusProvider === 'anthropic'
      ? readClaudeContributionCapSnapshotState({ credential, snapshot })
      : null;
    const claudeCapEvaluation = normalizedStatusProvider === 'anthropic'
      ? evaluateClaudeContributionCap({ credential, snapshot, now })
      : null;

    const fiveHourUsageExhausted = snapshot ? snapshot.fiveHourUtilizationRatio >= 1 : null;
    const sevenDayUsageExhausted = snapshot ? snapshot.sevenDayUtilizationRatio >= 1 : null;

    const derivedStatus = deriveDashboardTokenStatusRow({
      provider: normalizedStatusProvider,
      rawStatus: credential.status,
      authDiagnosis: auth.authDiagnosis,
      accessTokenExpiresAt: auth.accessTokenExpiresAt,
      refreshTokenState: auth.refreshTokenState,
      consecutiveFailures: credential.consecutiveFailureCount,
      consecutiveRateLimitCount: credential.consecutiveRateLimitCount,
      lastFailedStatus: credential.lastFailedStatus,
      rateLimitedUntil: credential.rateLimitedUntil,
      nextProbeAt: credential.nextProbeAt,
      fiveHourReservePercent: credential.fiveHourReservePercent,
      fiveHourUtilizationRatio: snapshot?.fiveHourUtilizationRatio ?? null,
      fiveHourResetsAt: snapshot?.fiveHourResetsAt ?? null,
      fiveHourContributionCapExhausted: claudeState?.fiveHourContributionCapExhausted ?? null,
      sevenDayReservePercent: credential.sevenDayReservePercent,
      sevenDayUtilizationRatio: snapshot?.sevenDayUtilizationRatio ?? null,
      sevenDayResetsAt: snapshot?.sevenDayResetsAt ?? null,
      sevenDayContributionCapExhausted: claudeState?.sevenDayContributionCapExhausted ?? null,
      providerUsageFetchedAt: snapshot?.fetchedAt ?? null,
      now
    });

    return {
      credentialId: credential.id,
      orgId: credential.orgId,
      provider: credential.provider,
      debugLabel: credential.debugLabel,
      status: derivedStatus.compactStatus,
      rawStatus: derivedStatus.rawStatus,
      expandedStatus: derivedStatus.expandedStatus,
      statusSource: derivedStatus.statusSource,
      exclusionReason: derivedStatus.exclusionReason,
      authDiagnosis: auth.authDiagnosis,
      accessTokenExpiresAt: auth.accessTokenExpiresAt,
      refreshTokenState: auth.refreshTokenState,
      expiresAt: credential.expiresAt.toISOString(),
      rateLimitedUntil: credential.rateLimitedUntil?.toISOString() ?? null,
      nextProbeAt: credential.nextProbeAt?.toISOString() ?? null,
      fiveHourReservePercent: credential.fiveHourReservePercent,
      sevenDayReservePercent: credential.sevenDayReservePercent,
      providerUsageRefreshSupported,
      providerUsageSource: snapshot?.usageSource ?? null,
      providerUsageFetchedAt: snapshot?.fetchedAt.toISOString() ?? null,
      providerUsageState,
      providerUsageWarning: deriveProviderUsageWarning({
        provider: normalizedStatusProvider,
        providerUsageState,
        snapshot,
        claudeCapEvaluation
      }),
      fiveHourUtilizationRatio: snapshot?.fiveHourUtilizationRatio ?? null,
      fiveHourResetsAt: snapshot?.fiveHourResetsAt?.toISOString() ?? null,
      fiveHourContributionCapExhausted: claudeState?.fiveHourContributionCapExhausted ?? null,
      fiveHourUsageExhausted,
      sevenDayUtilizationRatio: snapshot?.sevenDayUtilizationRatio ?? null,
      sevenDayResetsAt: snapshot?.sevenDayResetsAt?.toISOString() ?? null,
      sevenDayContributionCapExhausted: claudeState?.sevenDayContributionCapExhausted ?? null,
      sevenDayUsageExhausted
    };
  });
}

function deriveProviderUsageState(input: {
  snapshot: TokenCredentialProviderUsageSnapshot | null;
  supported: boolean;
  now: Date;
}): ConnectedAccountProviderUsageState {
  if (!input.supported) return 'unsupported';
  if (!input.snapshot) return 'missing';

  const ageMs = Math.max(0, input.now.getTime() - input.snapshot.fetchedAt.getTime());
  if (ageMs > readTokenCredentialProviderUsageHardStaleMs()) {
    return 'hard_stale';
  }
  if (ageMs > readTokenCredentialProviderUsageSoftStaleMs()) {
    return 'soft_stale';
  }
  return 'fresh';
}

function deriveProviderUsageWarning(input: {
  provider: string;
  providerUsageState: ConnectedAccountProviderUsageState;
  snapshot: TokenCredentialProviderUsageSnapshot | null;
  claudeCapEvaluation: ReturnType<typeof evaluateClaudeContributionCap> | null;
}): string | null {
  if (input.provider === 'anthropic' && input.claudeCapEvaluation?.exclusionReason) {
    return input.claudeCapEvaluation.exclusionReason;
  }

  switch (input.providerUsageState) {
    case 'missing':
      return 'provider_usage_snapshot_missing';
    case 'soft_stale':
      return 'provider_usage_snapshot_soft_stale';
    case 'hard_stale':
      return 'provider_usage_snapshot_hard_stale';
    default:
      break;
  }

  if (!input.snapshot) return null;
  if (input.snapshot.fiveHourUtilizationRatio >= 1) return 'usage_exhausted_5h';
  if (input.snapshot.sevenDayUtilizationRatio >= 1) return 'usage_exhausted_7d';
  return null;
}
