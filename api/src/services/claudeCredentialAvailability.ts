import {
  CLAUDE_REPEATED_429_LOCAL_BACKOFF_REASON,
  readTokenCredentialProviderUsageHardStaleMs,
  readTokenCredentialProviderUsageSoftStaleMs
} from './tokenCredentialProviderUsage.js';

export type ClaudeCredentialLike = {
  provider: string;
  status: string;
  accessToken?: string | null;
  fiveHourReservePercent?: number | null;
  sevenDayReservePercent?: number | null;
  consecutiveFailureCount?: number | null;
  consecutiveRateLimitCount?: number | null;
  lastFailedStatus?: number | null;
  rateLimitedUntil?: Date | string | null;
  nextProbeAt?: Date | string | null;
};

export type ClaudeProviderUsageLike = {
  fetchedAt?: Date | string | null;
  fiveHourUtilizationRatio?: number | null;
  fiveHourResetsAt?: Date | string | null;
  sevenDayUtilizationRatio?: number | null;
  sevenDayResetsAt?: Date | string | null;
};

export type ClaudeCredentialAvailabilityReason =
  | 'auth_failed'
  | typeof CLAUDE_REPEATED_429_LOCAL_BACKOFF_REASON
  | 'provider_usage_snapshot_missing'
  | 'provider_usage_snapshot_hard_stale'
  | 'contribution_cap_exhausted_5h'
  | 'contribution_cap_exhausted_7d'
  | null;

export type ClaudeCredentialAvailability = {
  inScope: boolean;
  displayStatus: string;
  blocked: boolean;
  blockReason: ClaudeCredentialAvailabilityReason;
  nextCheckAt: Date | null;
  reserveConfigured: boolean;
  providerUsageSnapshotState: 'missing' | 'fresh' | 'soft_stale' | 'hard_stale';
  providerUsageFetchedAt: Date | null;
  isFresh: boolean;
  isSoftStale: boolean;
  isHardStale: boolean;
  authFailed: boolean;
  repeated429LocalBackoffActive: boolean;
  fiveHourContributionCapExhausted: boolean;
  sevenDayContributionCapExhausted: boolean;
  fiveHourProviderUsageExhausted: boolean;
  sevenDayProviderUsageExhausted: boolean;
  fiveHourProviderUsageHoldActive: boolean;
  sevenDayProviderUsageHoldActive: boolean;
  fiveHourResetsAt: Date | null;
  sevenDayResetsAt: Date | null;
};

const DEFAULT_CLAUDE_REPEATED_429_THRESHOLD = 10;

function readIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function readClaudeRepeated429Threshold(): number {
  return readIntEnv('TOKEN_CREDENTIAL_RATE_LIMIT_CONSECUTIVE_FAILURES', DEFAULT_CLAUDE_REPEATED_429_THRESHOLD);
}

function readOptionalDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function readPercent(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.floor(value ?? 0)));
}

function readRatio(value: number | null | undefined): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Number(value));
}

function isClaudeManagedCredential(input: ClaudeCredentialLike): boolean {
  if (input.provider !== 'anthropic') return false;
  if (!input.accessToken) return true;
  return input.accessToken.includes('sk-ant-oat');
}

function deriveDisplayStatus(input: {
  rawStatus: string;
  rateLimitedUntil: Date | null;
  nowMs: number;
  usageMaxed: boolean;
}): string {
  if (input.usageMaxed) return 'maxed';
  if (input.rawStatus === 'maxed') return 'rate_limited';
  if (
    input.rawStatus === 'active'
    && input.rateLimitedUntil !== null
    && input.rateLimitedUntil.getTime() > input.nowMs
  ) {
    return 'rate_limited';
  }
  return input.rawStatus;
}

export function evaluateClaudeCredentialAvailability(input: {
  credential: ClaudeCredentialLike;
  snapshot: ClaudeProviderUsageLike | null;
  now?: Date;
  rateLimitThreshold?: number;
}): ClaudeCredentialAvailability {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const rawStatus = input.credential.status.trim().toLowerCase();
  const rateLimitedUntil = readOptionalDate(input.credential.rateLimitedUntil);
  const nextProbeAt = readOptionalDate(input.credential.nextProbeAt);
  const reserve5h = readPercent(input.credential.fiveHourReservePercent);
  const reserve7d = readPercent(input.credential.sevenDayReservePercent);
  const reserveConfigured = reserve5h > 0 || reserve7d > 0;
  const inScope = isClaudeManagedCredential(input.credential);
  const threshold = input.rateLimitThreshold ?? readClaudeRepeated429Threshold();

  if (!inScope) {
    return {
      inScope,
      displayStatus: deriveDisplayStatus({
        rawStatus,
        rateLimitedUntil,
        nowMs,
        usageMaxed: false
      }),
      blocked: false,
      blockReason: null,
      nextCheckAt: null,
      reserveConfigured,
      providerUsageSnapshotState: 'missing',
      providerUsageFetchedAt: null,
      isFresh: true,
      isSoftStale: false,
      isHardStale: false,
      authFailed: false,
      repeated429LocalBackoffActive: false,
      fiveHourContributionCapExhausted: false,
      sevenDayContributionCapExhausted: false,
      fiveHourProviderUsageExhausted: false,
      sevenDayProviderUsageExhausted: false,
      fiveHourProviderUsageHoldActive: false,
      sevenDayProviderUsageHoldActive: false,
      fiveHourResetsAt: null,
      sevenDayResetsAt: null
    };
  }

  if (rawStatus !== 'active' && rawStatus !== 'maxed') {
    return {
      inScope,
      displayStatus: rawStatus,
      blocked: false,
      blockReason: null,
      nextCheckAt: null,
      reserveConfigured,
      providerUsageSnapshotState: 'missing',
      providerUsageFetchedAt: null,
      isFresh: true,
      isSoftStale: false,
      isHardStale: false,
      authFailed: false,
      repeated429LocalBackoffActive: false,
      fiveHourContributionCapExhausted: false,
      sevenDayContributionCapExhausted: false,
      fiveHourProviderUsageExhausted: false,
      sevenDayProviderUsageExhausted: false,
      fiveHourProviderUsageHoldActive: false,
      sevenDayProviderUsageHoldActive: false,
      fiveHourResetsAt: null,
      sevenDayResetsAt: null
    };
  }

  const providerUsageFetchedAt = readOptionalDate(input.snapshot?.fetchedAt);
  const fiveHourUtilizationRatio = readRatio(input.snapshot?.fiveHourUtilizationRatio);
  const sevenDayUtilizationRatio = readRatio(input.snapshot?.sevenDayUtilizationRatio);
  const fiveHourResetsAt = readOptionalDate(input.snapshot?.fiveHourResetsAt);
  const sevenDayResetsAt = readOptionalDate(input.snapshot?.sevenDayResetsAt);
  const snapshotMissing = providerUsageFetchedAt === null;
  const ageMs = providerUsageFetchedAt === null ? null : Math.max(0, nowMs - providerUsageFetchedAt.getTime());
  const isHardStale = ageMs !== null && ageMs > readTokenCredentialProviderUsageHardStaleMs();
  const isSoftStale = ageMs !== null && !isHardStale && ageMs > readTokenCredentialProviderUsageSoftStaleMs();
  const isFresh = !snapshotMissing && !isSoftStale && !isHardStale;
  const fiveHourContributionCapExhausted = fiveHourUtilizationRatio !== null
    && (fiveHourUtilizationRatio * 100) >= (100 - reserve5h);
  const sevenDayContributionCapExhausted = sevenDayUtilizationRatio !== null
    && (sevenDayUtilizationRatio * 100) >= (100 - reserve7d);
  const fiveHourProviderUsageExhausted = fiveHourUtilizationRatio !== null && fiveHourUtilizationRatio >= 1;
  const sevenDayProviderUsageExhausted = sevenDayUtilizationRatio !== null && sevenDayUtilizationRatio >= 1;
  const fiveHourProviderUsageHoldActive = fiveHourProviderUsageExhausted
    && fiveHourResetsAt !== null
    && fiveHourResetsAt.getTime() > nowMs;
  const sevenDayProviderUsageHoldActive = sevenDayProviderUsageExhausted
    && sevenDayResetsAt !== null
    && sevenDayResetsAt.getTime() > nowMs;
  const authFailed = rawStatus === 'maxed'
    && (
      input.credential.lastFailedStatus === 401
      || input.credential.lastFailedStatus === 403
      || Number(input.credential.consecutiveFailureCount ?? 0) > 0
    );

  const repeated429LocalBackoffActive = Number(input.credential.consecutiveRateLimitCount ?? 0) >= threshold
    && (snapshotMissing || isSoftStale || isHardStale || fiveHourContributionCapExhausted || sevenDayContributionCapExhausted);

  if (authFailed) {
    return {
      inScope,
      displayStatus: 'rate_limited',
      blocked: true,
      blockReason: 'auth_failed',
      nextCheckAt: nextProbeAt,
      reserveConfigured,
      providerUsageSnapshotState: snapshotMissing ? 'missing' : isHardStale ? 'hard_stale' : isSoftStale ? 'soft_stale' : 'fresh',
      providerUsageFetchedAt,
      isFresh,
      isSoftStale,
      isHardStale,
      authFailed,
      repeated429LocalBackoffActive: false,
      fiveHourContributionCapExhausted,
      sevenDayContributionCapExhausted,
      fiveHourProviderUsageExhausted,
      sevenDayProviderUsageExhausted,
      fiveHourProviderUsageHoldActive,
      sevenDayProviderUsageHoldActive,
      fiveHourResetsAt,
      sevenDayResetsAt
    };
  }

  if (fiveHourContributionCapExhausted) {
    return {
      inScope,
      displayStatus: 'maxed',
      blocked: true,
      blockReason: 'contribution_cap_exhausted_5h',
      nextCheckAt: fiveHourResetsAt,
      reserveConfigured,
      providerUsageSnapshotState: snapshotMissing ? 'missing' : isHardStale ? 'hard_stale' : isSoftStale ? 'soft_stale' : 'fresh',
      providerUsageFetchedAt,
      isFresh,
      isSoftStale,
      isHardStale,
      authFailed: false,
      repeated429LocalBackoffActive: false,
      fiveHourContributionCapExhausted,
      sevenDayContributionCapExhausted,
      fiveHourProviderUsageExhausted,
      sevenDayProviderUsageExhausted,
      fiveHourProviderUsageHoldActive,
      sevenDayProviderUsageHoldActive,
      fiveHourResetsAt,
      sevenDayResetsAt
    };
  }

  if (sevenDayContributionCapExhausted) {
    return {
      inScope,
      displayStatus: 'maxed',
      blocked: true,
      blockReason: 'contribution_cap_exhausted_7d',
      nextCheckAt: sevenDayResetsAt,
      reserveConfigured,
      providerUsageSnapshotState: snapshotMissing ? 'missing' : isHardStale ? 'hard_stale' : isSoftStale ? 'soft_stale' : 'fresh',
      providerUsageFetchedAt,
      isFresh,
      isSoftStale,
      isHardStale,
      authFailed: false,
      repeated429LocalBackoffActive: false,
      fiveHourContributionCapExhausted,
      sevenDayContributionCapExhausted,
      fiveHourProviderUsageExhausted,
      sevenDayProviderUsageExhausted,
      fiveHourProviderUsageHoldActive,
      sevenDayProviderUsageHoldActive,
      fiveHourResetsAt,
      sevenDayResetsAt
    };
  }

  if (snapshotMissing && reserveConfigured) {
    return {
      inScope,
      displayStatus: 'rate_limited',
      blocked: true,
      blockReason: 'provider_usage_snapshot_missing',
      nextCheckAt: null,
      reserveConfigured,
      providerUsageSnapshotState: 'missing',
      providerUsageFetchedAt,
      isFresh: false,
      isSoftStale: false,
      isHardStale: false,
      authFailed: false,
      repeated429LocalBackoffActive,
      fiveHourContributionCapExhausted,
      sevenDayContributionCapExhausted,
      fiveHourProviderUsageExhausted,
      sevenDayProviderUsageExhausted,
      fiveHourProviderUsageHoldActive,
      sevenDayProviderUsageHoldActive,
      fiveHourResetsAt,
      sevenDayResetsAt
    };
  }

  if (isHardStale && reserveConfigured) {
    return {
      inScope,
      displayStatus: 'rate_limited',
      blocked: true,
      blockReason: 'provider_usage_snapshot_hard_stale',
      nextCheckAt: null,
      reserveConfigured,
      providerUsageSnapshotState: 'hard_stale',
      providerUsageFetchedAt,
      isFresh,
      isSoftStale,
      isHardStale,
      authFailed: false,
      repeated429LocalBackoffActive,
      fiveHourContributionCapExhausted,
      sevenDayContributionCapExhausted,
      fiveHourProviderUsageExhausted,
      sevenDayProviderUsageExhausted,
      fiveHourProviderUsageHoldActive,
      sevenDayProviderUsageHoldActive,
      fiveHourResetsAt,
      sevenDayResetsAt
    };
  }

  if (repeated429LocalBackoffActive) {
    return {
      inScope,
      displayStatus: 'rate_limited',
      blocked: true,
      blockReason: CLAUDE_REPEATED_429_LOCAL_BACKOFF_REASON,
      nextCheckAt: rateLimitedUntil,
      reserveConfigured,
      providerUsageSnapshotState: snapshotMissing ? 'missing' : isHardStale ? 'hard_stale' : isSoftStale ? 'soft_stale' : 'fresh',
      providerUsageFetchedAt,
      isFresh,
      isSoftStale,
      isHardStale,
      authFailed: false,
      repeated429LocalBackoffActive,
      fiveHourContributionCapExhausted,
      sevenDayContributionCapExhausted,
      fiveHourProviderUsageExhausted,
      sevenDayProviderUsageExhausted,
      fiveHourProviderUsageHoldActive,
      sevenDayProviderUsageHoldActive,
      fiveHourResetsAt,
      sevenDayResetsAt
    };
  }

  const displayStatus = deriveDisplayStatus({
    rawStatus,
    rateLimitedUntil,
    nowMs,
    usageMaxed: false
  });

  return {
    inScope,
    displayStatus,
    blocked: displayStatus === 'rate_limited' || rawStatus === 'maxed',
    blockReason: rawStatus === 'maxed' ? CLAUDE_REPEATED_429_LOCAL_BACKOFF_REASON : null,
    nextCheckAt: rawStatus === 'maxed' ? nextProbeAt : rateLimitedUntil,
    reserveConfigured,
    providerUsageSnapshotState: snapshotMissing ? 'missing' : isHardStale ? 'hard_stale' : isSoftStale ? 'soft_stale' : 'fresh',
    providerUsageFetchedAt,
    isFresh,
    isSoftStale,
    isHardStale,
    authFailed: false,
    repeated429LocalBackoffActive: false,
    fiveHourContributionCapExhausted,
    sevenDayContributionCapExhausted,
    fiveHourProviderUsageExhausted,
    sevenDayProviderUsageExhausted,
    fiveHourProviderUsageHoldActive,
    sevenDayProviderUsageHoldActive,
    fiveHourResetsAt,
    sevenDayResetsAt
  };
}
