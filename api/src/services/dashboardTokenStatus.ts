import { readTokenCredentialProviderUsageSoftStaleMs } from './tokenCredentialProviderUsage.js';

export type DashboardCompactStatus =
  | 'active'
  | 'active*'
  | 'paused'
  | 'rotating'
  | 'benched'
  | 'expired'
  | 'revoked';

export type DashboardStatusSource = 'backend_maxed' | 'cap_exhausted' | 'usage_exhausted' | null;

export type DashboardExclusionReason =
  | 'rate_limited'
  | 'rate_limited_escalated'
  | 'snapshot_missing'
  | 'snapshot_stale'
  | null;

export type DashboardTokenStatusInput = {
  provider: string;
  rawStatus: string;
  authDiagnosis?: string | null;
  accessTokenExpiresAt?: Date | string | null;
  refreshTokenState?: 'missing' | 'present' | null;
  consecutiveFailures?: number | null;
  consecutiveRateLimitCount?: number | null;
  lastFailedStatus?: number | null;
  rateLimitedUntil?: Date | string | null;
  nextProbeAt?: Date | string | null;
  fiveHourReservePercent?: number | null;
  fiveHourUtilizationRatio?: number | null;
  fiveHourResetsAt?: Date | string | null;
  fiveHourContributionCapExhausted?: boolean | null;
  sevenDayReservePercent?: number | null;
  sevenDayUtilizationRatio?: number | null;
  sevenDayResetsAt?: Date | string | null;
  sevenDayContributionCapExhausted?: boolean | null;
  providerUsageFetchedAt?: Date | string | null;
  now?: Date | string | null;
};

export type DashboardTokenStatusOutput = {
  rawStatus: string;
  compactStatus: DashboardCompactStatus;
  expandedStatus: string;
  statusSource: DashboardStatusSource;
  exclusionReason: DashboardExclusionReason;
  hidden: boolean;
};

const DEFAULT_CLAUDE_REPEATED_429_THRESHOLD = 10;

function parseOptionalDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function buildStatusOutput(input: {
  rawStatus: string;
  compactStatus: DashboardCompactStatus;
  expandedStatus: string;
  statusSource?: DashboardStatusSource;
  exclusionReason?: DashboardExclusionReason;
  hidden?: boolean;
}): DashboardTokenStatusOutput {
  return {
    rawStatus: input.rawStatus,
    compactStatus: input.compactStatus,
    expandedStatus: input.expandedStatus,
    statusSource: input.statusSource ?? null,
    exclusionReason: input.exclusionReason ?? null,
    hidden: input.hidden ?? false
  };
}

function buildAuthDetailSuffix(input: Pick<DashboardTokenStatusInput, 'authDiagnosis' | 'refreshTokenState'>): string {
  const segments: string[] = [];
  if (input.authDiagnosis) {
    segments.push(`auth: ${input.authDiagnosis}`);
  }
  if (input.refreshTokenState === 'missing') {
    segments.push('refresh: missing');
  }
  return segments.length > 0 ? `, ${segments.join(', ')}` : '';
}

function isActiveCooldown(rateLimitedUntil: Date | string | null | undefined, now: Date): boolean {
  const until = parseOptionalDate(rateLimitedUntil);
  return until !== null && until.getTime() > now.getTime();
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readClaudeRepeated429Threshold(): number {
  return readPositiveIntEnv('TOKEN_CREDENTIAL_RATE_LIMIT_CONSECUTIVE_FAILURES', DEFAULT_CLAUDE_REPEATED_429_THRESHOLD);
}

function hasAnthropicRepeated429Escalation(
  input: Pick<DashboardTokenStatusInput, 'consecutiveRateLimitCount'>,
  cooldownActive: boolean
): boolean {
  return cooldownActive && Number(input.consecutiveRateLimitCount ?? 0) >= readClaudeRepeated429Threshold();
}

function deriveAnthropicSnapshotExclusionReason(
  input: Pick<
    DashboardTokenStatusInput,
    'fiveHourReservePercent' | 'sevenDayReservePercent' | 'providerUsageFetchedAt'
  >,
  now: Date
): Extract<DashboardExclusionReason, 'snapshot_missing' | 'snapshot_stale'> | null {
  const reserveConfigured = (input.fiveHourReservePercent ?? 0) > 0 || (input.sevenDayReservePercent ?? 0) > 0;
  if (!reserveConfigured) {
    return null;
  }

  const fetchedAt = parseOptionalDate(input.providerUsageFetchedAt);
  if (fetchedAt === null) {
    return 'snapshot_missing';
  }

  const ageMs = Math.max(0, now.getTime() - fetchedAt.getTime());
  return ageMs > readTokenCredentialProviderUsageSoftStaleMs()
    ? 'snapshot_stale'
    : null;
}

function hasOpenAiUsageExhausted(input: Pick<
  DashboardTokenStatusInput,
  'provider' | 'fiveHourUtilizationRatio' | 'sevenDayUtilizationRatio'
>): boolean {
  const provider = input.provider.trim().toLowerCase();
  if (provider !== 'openai') {
    return false;
  }

  return (input.fiveHourUtilizationRatio ?? 0) >= 1
    || (input.sevenDayUtilizationRatio ?? 0) >= 1;
}

export function deriveDashboardTokenStatusRow(
  input: DashboardTokenStatusInput
): DashboardTokenStatusOutput {
  const rawStatus = input.rawStatus.trim().toLowerCase();
  const provider = input.provider.trim().toLowerCase();
  const now = parseOptionalDate(input.now) ?? new Date();
  const cooldownActive = isActiveCooldown(input.rateLimitedUntil, now);

  if (rawStatus === 'expired' || rawStatus === 'revoked') {
    return buildStatusOutput({
      rawStatus,
      compactStatus: rawStatus,
      expandedStatus: rawStatus,
      hidden: true
    });
  }

  if (rawStatus === 'paused' || rawStatus === 'rotating') {
    return buildStatusOutput({
      rawStatus,
      compactStatus: rawStatus,
      expandedStatus: rawStatus
    });
  }

  if (rawStatus === 'maxed') {
    return buildStatusOutput({
      rawStatus,
      compactStatus: 'benched',
      expandedStatus: `benched, source: backend_maxed${buildAuthDetailSuffix(input)}`,
      statusSource: 'backend_maxed'
    });
  }

  const capExhausted = input.fiveHourContributionCapExhausted === true
    || input.sevenDayContributionCapExhausted === true;

  if (rawStatus === 'active' && capExhausted) {
    return buildStatusOutput({
      rawStatus,
      compactStatus: 'benched',
      expandedStatus: 'benched, source: cap_exhausted',
      statusSource: 'cap_exhausted'
    });
  }

  if (rawStatus === 'active' && hasOpenAiUsageExhausted(input)) {
    return buildStatusOutput({
      rawStatus,
      compactStatus: 'benched',
      expandedStatus: 'benched, source: usage_exhausted',
      statusSource: 'usage_exhausted'
    });
  }

  if (rawStatus !== 'active') {
    return buildStatusOutput({
      rawStatus,
      compactStatus: 'active',
      expandedStatus: rawStatus
    });
  }

  if (provider === 'anthropic') {
    if (hasAnthropicRepeated429Escalation(input, cooldownActive)) {
      return buildStatusOutput({
        rawStatus,
        compactStatus: 'active*',
        expandedStatus: 'active, excluded: rate_limited (escalated)',
        exclusionReason: 'rate_limited_escalated'
      });
    }

    if (cooldownActive) {
      return buildStatusOutput({
        rawStatus,
        compactStatus: 'active*',
        expandedStatus: 'active, excluded: rate_limited',
        exclusionReason: 'rate_limited'
      });
    }

    const snapshotExclusionReason = deriveAnthropicSnapshotExclusionReason(input, now);

    if (snapshotExclusionReason === 'snapshot_missing') {
      return buildStatusOutput({
        rawStatus,
        compactStatus: 'active*',
        expandedStatus: 'active, excluded: snapshot_missing',
        exclusionReason: 'snapshot_missing'
      });
    }

    if (snapshotExclusionReason === 'snapshot_stale') {
      return buildStatusOutput({
        rawStatus,
        compactStatus: 'active*',
        expandedStatus: 'active, excluded: snapshot_stale',
        exclusionReason: 'snapshot_stale'
      });
    }
  }

  if (cooldownActive) {
    return buildStatusOutput({
      rawStatus,
      compactStatus: 'active*',
      expandedStatus: 'active, excluded: rate_limited',
      exclusionReason: 'rate_limited'
    });
  }

  return buildStatusOutput({
    rawStatus,
    compactStatus: 'active',
    expandedStatus: 'active'
  });
}
