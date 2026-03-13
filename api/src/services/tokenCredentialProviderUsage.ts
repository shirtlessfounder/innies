import type { TokenCredential } from '../repos/tokenCredentialRepository.js';
import type {
  ProviderUsageSource,
  TokenCredentialProviderUsageRepository,
  TokenCredentialProviderUsageSnapshot,
  UpsertTokenCredentialProviderUsageInput
} from '../repos/tokenCredentialProviderUsageRepository.js';
import {
  clearAnthropicUsageRefreshFailure,
  getAnthropicUsageRetryBackoff,
  markAnthropicUsageRefreshFailure
} from './tokenCredentialProviderUsageRetryState.js';
import { readClaudeContributionCapSnapshotState } from './claudeContributionCapState.js';

const DEFAULT_PROVIDER_USAGE_POLL_MS = 60 * 1000;
const DEFAULT_PROVIDER_USAGE_TIMEOUT_MS = 10 * 1000;
const DEFAULT_PROVIDER_USAGE_SOFT_STALE_MS = 2 * 60 * 1000;
const DEFAULT_PROVIDER_USAGE_HARD_STALE_MS = 10 * 60 * 1000;
const DEFAULT_RATE_LIMIT_LONG_BACKOFF_MINUTES = 15;
const DEFAULT_ANTHROPIC_OAUTH_USAGE_USER_AGENT = 'claude-code/2.1.34';

const ANTHROPIC_OAUTH_USAGE_BETA = 'oauth-2025-04-20';
const ANTHROPIC_OAUTH_USAGE_PATH = '/api/oauth/usage';
const inFlightAnthropicUsageRefreshes = new Map<string, Promise<AnthropicOauthUsageRefreshOutcome>>();
export const PROVIDER_USAGE_FETCH_FAILED_REASON = 'provider_usage_fetch_failed';
export const PROVIDER_USAGE_FETCH_BACKOFF_ACTIVE_REASON = 'provider_usage_fetch_backoff_active';
export const CLAUDE_REPEATED_429_LOCAL_BACKOFF_REASON = 'claude_repeated_429_local_backoff';
export type ProviderUsageWarningReason =
  | typeof PROVIDER_USAGE_FETCH_FAILED_REASON
  | typeof PROVIDER_USAGE_FETCH_BACKOFF_ACTIVE_REASON;
export type AnthropicOauthUsageRefreshOutcome =
  | {
      ok: true;
      snapshot: TokenCredentialProviderUsageSnapshot;
      rawPayload: Record<string, unknown>;
    }
  | {
      ok: false;
      reason: string;
      statusCode: number | null;
      category: 'fetch_failed' | 'fetch_backoff' | 'snapshot_write_failed';
      warningReason: typeof PROVIDER_USAGE_FETCH_FAILED_REASON | null;
      rawPayload?: Record<string, unknown>;
      retryAfterMs?: number;
      errorMessage?: string;
    };

export function providerUsageWarningReasonFromRefreshOutcome(
  outcome: AnthropicOauthUsageRefreshOutcome
): ProviderUsageWarningReason | null {
  if (outcome.ok) return null;
  if (outcome.category === 'fetch_backoff') return PROVIDER_USAGE_FETCH_BACKOFF_ACTIVE_REASON;
  if (outcome.category === 'fetch_failed') return PROVIDER_USAGE_FETCH_FAILED_REASON;
  return null;
}

export type ClaudeContributionCapEvaluation = {
  inScope: boolean;
  eligible: boolean;
  exclusionReason:
    | 'provider_usage_snapshot_missing'
    | 'provider_usage_snapshot_hard_stale'
    | 'contribution_cap_exhausted_5h'
    | 'contribution_cap_exhausted_7d'
    | null;
  warningReason: 'provider_usage_snapshot_soft_stale' | null;
  isFresh: boolean;
  isSoftStale: boolean;
  isHardStale: boolean;
  routeDecisionMeta: Record<string, unknown>;
};

function readIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function readTokenCredentialProviderUsagePollMs(): number {
  return readIntEnv('TOKEN_CREDENTIAL_PROVIDER_USAGE_POLL_MS', DEFAULT_PROVIDER_USAGE_POLL_MS);
}

export function readTokenCredentialProviderUsageTimeoutMs(): number {
  return readIntEnv('TOKEN_CREDENTIAL_PROVIDER_USAGE_TIMEOUT_MS', DEFAULT_PROVIDER_USAGE_TIMEOUT_MS);
}

export function readTokenCredentialProviderUsageSoftStaleMs(): number {
  return readIntEnv('TOKEN_CREDENTIAL_PROVIDER_USAGE_SOFT_STALE_MS', DEFAULT_PROVIDER_USAGE_SOFT_STALE_MS);
}

export function readTokenCredentialProviderUsageHardStaleMs(): number {
  return readIntEnv('TOKEN_CREDENTIAL_PROVIDER_USAGE_HARD_STALE_MS', DEFAULT_PROVIDER_USAGE_HARD_STALE_MS);
}

export function readTokenCredentialRateLimitLongBackoffMinutes(): number {
  return readIntEnv('TOKEN_CREDENTIAL_RATE_LIMIT_LONG_BACKOFF_MINUTES', DEFAULT_RATE_LIMIT_LONG_BACKOFF_MINUTES);
}

export function isAnthropicOauthTokenCredential(credential: Pick<TokenCredential, 'provider' | 'accessToken'>): boolean {
  return credential.provider === 'anthropic' && credential.accessToken.includes('sk-ant-oat');
}

function readAnthropicOauthUsageUrl(): URL {
  const baseUrl = process.env.ANTHROPIC_OAUTH_USAGE_BASE_URL
    || process.env.ANTHROPIC_UPSTREAM_BASE_URL
    || 'https://api.anthropic.com';
  const path = process.env.ANTHROPIC_OAUTH_USAGE_PATH || ANTHROPIC_OAUTH_USAGE_PATH;
  return new URL(path, baseUrl);
}

function readAnthropicOauthUsageUserAgent(): string {
  const configured = process.env.ANTHROPIC_OAUTH_USAGE_USER_AGENT?.trim();
  return configured && configured.length > 0
    ? configured
    : DEFAULT_ANTHROPIC_OAUTH_USAGE_USER_AGENT;
}

function buildAnthropicOauthUsageHeaders(credential: TokenCredential): Record<string, string> {
  return {
    authorization: `Bearer ${credential.accessToken}`,
    accept: 'application/json',
    'content-type': 'application/json',
    'anthropic-beta': ANTHROPIC_OAUTH_USAGE_BETA,
    'user-agent': readAnthropicOauthUsageUserAgent()
  };
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNumberField(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readDateField(record: Record<string, unknown>, keys: string[]): Date | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function normalizeUtilizationRatio(value: number | null): number | null {
  if (value === null) return null;
  if (value < 0) return 0;
  if (value <= 1) return value;
  if (value <= 100) return value / 100;
  return 1;
}

function readUsageWindow(record: Record<string, unknown>, aliases: string[], prefix: string): {
  utilizationRatio: number | null;
  resetsAt: Date | null;
} {
  for (const alias of aliases) {
    const windowRecord = readObject(record[alias]);
    if (!windowRecord) continue;
    const utilizationRatio = normalizeUtilizationRatio(readNumberField(windowRecord, [
      'utilization_ratio',
      'utilizationRatio',
      'utilization',
      'percent',
      'percentage',
      'used_percent',
      'usedPercent'
    ]));
    return {
      utilizationRatio,
      resetsAt: readDateField(windowRecord, ['resets_at', 'resetsAt', 'reset_at', 'resetAt', 'reset_time', 'resetTime'])
    };
  }
  return {
    utilizationRatio: normalizeUtilizationRatio(readNumberField(record, [
      `${prefix}_utilization_ratio`,
      `${prefix}UtilizationRatio`,
      `${prefix}_utilization`,
      `${prefix}Utilization`,
      `${prefix}_percent`,
      `${prefix}Percent`
    ])),
    resetsAt: readDateField(record, [
      `${prefix}_resets_at`,
      `${prefix}ResetsAt`,
      `${prefix}_reset_at`,
      `${prefix}ResetAt`
    ])
  };
}

function parseAnthropicOauthUsagePayload(payload: unknown): {
  usageSource: ProviderUsageSource;
  fiveHourUtilizationRatio: number;
  fiveHourResetsAt: Date | null;
  sevenDayUtilizationRatio: number;
  sevenDayResetsAt: Date | null;
  rawPayload: Record<string, unknown>;
} {
  const record = readObject(payload);
  if (!record) {
    throw new Error('invalid_payload:not_object');
  }
  const fiveHour = readUsageWindow(record, ['5h', 'five_hour', 'fiveHour'], 'five_hour');
  const sevenDay = readUsageWindow(record, ['7d', 'seven_day', 'sevenDay'], 'seven_day');
  if (fiveHour.utilizationRatio === null || sevenDay.utilizationRatio === null) {
    throw new Error('invalid_payload:missing_utilization');
  }
  return {
    usageSource: 'anthropic_oauth_usage',
    fiveHourUtilizationRatio: fiveHour.utilizationRatio,
    fiveHourResetsAt: fiveHour.resetsAt,
    sevenDayUtilizationRatio: sevenDay.utilizationRatio,
    sevenDayResetsAt: sevenDay.resetsAt,
    rawPayload: record
  };
}

async function fetchAnthropicOauthUsagePayload(
  credential: TokenCredential,
  timeoutMs: number
): Promise<AnthropicOauthUsageRefreshOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(readAnthropicOauthUsageUrl(), {
      method: 'GET',
      headers: buildAnthropicOauthUsageHeaders(credential),
      signal: controller.signal
    });

    let payload: unknown = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    const payloadRecord = readObject(payload) ?? undefined;
    if (!response.ok) {
      return {
        ok: false,
        reason: `status_${response.status}`,
        statusCode: response.status,
        category: 'fetch_failed',
        warningReason: PROVIDER_USAGE_FETCH_FAILED_REASON,
        rawPayload: payloadRecord
      };
    }

    try {
      const parsed = parseAnthropicOauthUsagePayload(payload);
      return {
        ok: true,
        snapshot: {
          tokenCredentialId: credential.id,
          orgId: credential.orgId,
          provider: credential.provider,
          usageSource: parsed.usageSource,
          fiveHourUtilizationRatio: parsed.fiveHourUtilizationRatio,
          fiveHourResetsAt: parsed.fiveHourResetsAt,
          sevenDayUtilizationRatio: parsed.sevenDayUtilizationRatio,
          sevenDayResetsAt: parsed.sevenDayResetsAt,
          rawPayload: parsed.rawPayload,
          fetchedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        },
        rawPayload: parsed.rawPayload
      };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : 'invalid_payload',
        statusCode: response.status,
        category: 'fetch_failed',
        warningReason: PROVIDER_USAGE_FETCH_FAILED_REASON,
        rawPayload: payloadRecord
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'provider_usage_fetch_error';
    return {
      ok: false,
      reason: `network:${message}`,
      statusCode: null,
      category: 'fetch_failed',
      warningReason: PROVIDER_USAGE_FETCH_FAILED_REASON
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshAnthropicOauthUsageNow(
  repo: TokenCredentialProviderUsageRepository,
  credential: TokenCredential,
  options?: {
    timeoutMs?: number;
    ignoreRetryBackoff?: boolean;
  }
): Promise<AnthropicOauthUsageRefreshOutcome> {
  if (!isAnthropicOauthTokenCredential(credential)) {
    return {
      ok: false,
      reason: 'unsupported_credential',
      statusCode: null,
      category: 'fetch_failed',
      warningReason: null
    };
  }
  const existing = inFlightAnthropicUsageRefreshes.get(credential.id);
  if (existing) {
    return existing;
  }
  if (!options?.ignoreRetryBackoff) {
    const retryBackoff = getAnthropicUsageRetryBackoff(credential.id);
    if (retryBackoff) {
      return {
        ok: false,
        reason: PROVIDER_USAGE_FETCH_BACKOFF_ACTIVE_REASON,
        statusCode: retryBackoff.lastStatusCode,
        category: 'fetch_backoff',
        warningReason: PROVIDER_USAGE_FETCH_FAILED_REASON,
        retryAfterMs: retryBackoff.retryAfterMs
      };
    }
  }
  const refreshPromise: Promise<AnthropicOauthUsageRefreshOutcome> = (async (): Promise<AnthropicOauthUsageRefreshOutcome> => {
    const fetched = await fetchAnthropicOauthUsagePayload(
      credential,
      options?.timeoutMs ?? readTokenCredentialProviderUsageTimeoutMs()
    );
    if (!fetched.ok) {
      const retryBackoff = markAnthropicUsageRefreshFailure(credential.id, fetched.reason, fetched.statusCode);
      return {
        ...fetched,
        retryAfterMs: retryBackoff.retryAfterMs
      };
    }
    clearAnthropicUsageRefreshFailure(credential.id);
    try {
      const snapshot = await repo.upsertSnapshot({
        tokenCredentialId: credential.id,
        orgId: credential.orgId,
        provider: credential.provider,
        usageSource: fetched.snapshot.usageSource,
        fiveHourUtilizationRatio: fetched.snapshot.fiveHourUtilizationRatio,
        fiveHourResetsAt: fetched.snapshot.fiveHourResetsAt,
        sevenDayUtilizationRatio: fetched.snapshot.sevenDayUtilizationRatio,
        sevenDayResetsAt: fetched.snapshot.sevenDayResetsAt,
        rawPayload: fetched.rawPayload,
        fetchedAt: fetched.snapshot.fetchedAt
      });

      return {
        ok: true,
        snapshot,
        rawPayload: fetched.rawPayload
      };
    } catch (error) {
      return {
        ok: false as const,
        reason: 'provider_usage_snapshot_write_failed',
        statusCode: null,
        category: 'snapshot_write_failed' as const,
        warningReason: null,
        errorMessage: error instanceof Error ? error.message : 'snapshot_write_failed'
      };
    }
  })();
  inFlightAnthropicUsageRefreshes.set(credential.id, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    inFlightAnthropicUsageRefreshes.delete(credential.id);
  }
}

export function evaluateClaudeContributionCap(input: {
  credential: TokenCredential;
  snapshot: TokenCredentialProviderUsageSnapshot | null;
  now?: Date;
}): ClaudeContributionCapEvaluation {
  const { credential, snapshot } = input;
  const now = input.now ?? new Date();
  const state = readClaudeContributionCapSnapshotState({ credential, snapshot });
  const fiveHourReservePercent = state.fiveHourReservePercent;
  const sevenDayReservePercent = state.sevenDayReservePercent;
  const baseMeta: Record<string, unknown> = {
    claudeProviderUsageInScope: state.inScope,
    fiveHourReservePercent,
    sevenDayReservePercent
  };
  if (!state.inScope) {
    return {
      inScope: false,
      eligible: true,
      exclusionReason: null,
      warningReason: null,
      isFresh: true,
      isSoftStale: false,
      isHardStale: false,
      routeDecisionMeta: baseMeta
    };
  }
  if (!snapshot) {
    return {
      inScope: true,
      eligible: fiveHourReservePercent <= 0 && sevenDayReservePercent <= 0,
      exclusionReason: fiveHourReservePercent > 0 || sevenDayReservePercent > 0
        ? 'provider_usage_snapshot_missing'
        : null,
      warningReason: null,
      isFresh: false,
      isSoftStale: false,
      isHardStale: false,
      routeDecisionMeta: {
        ...baseMeta,
        providerUsageSnapshotState: 'missing',
        providerUsageFetchedAt: null
      }
    };
  }
  const fetchedAt = state.fetchedAt ?? snapshot.fetchedAt;
  const ageMs = Math.max(0, now.getTime() - fetchedAt.getTime());
  const softStaleMs = readTokenCredentialProviderUsageSoftStaleMs();
  const hardStaleMs = readTokenCredentialProviderUsageHardStaleMs();
  const isHardStale = ageMs > hardStaleMs;
  const isSoftStale = !isHardStale && ageMs > softStaleMs;
  const isFresh = !isSoftStale && !isHardStale;
  const routeDecisionMeta: Record<string, unknown> = {
    ...baseMeta,
    providerUsageSnapshotState: isHardStale ? 'hard_stale' : isSoftStale ? 'soft_stale' : 'fresh',
    providerUsageFetchedAt: fetchedAt.toISOString(),
    fiveHourUtilizationRatio: state.fiveHourUtilizationRatio,
    fiveHourResetsAt: state.fiveHourResetsAt?.toISOString() ?? null,
    sevenDayUtilizationRatio: state.sevenDayUtilizationRatio,
    sevenDayResetsAt: state.sevenDayResetsAt?.toISOString() ?? null,
    fiveHourSharedThresholdPercent: state.fiveHourSharedThresholdPercent,
    sevenDaySharedThresholdPercent: state.sevenDaySharedThresholdPercent,
    fiveHourContributionCapExhausted: state.fiveHourContributionCapExhausted,
    sevenDayContributionCapExhausted: state.sevenDayContributionCapExhausted
  };
  if (isHardStale) {
    return {
      inScope: true,
      eligible: fiveHourReservePercent <= 0 && sevenDayReservePercent <= 0,
      exclusionReason: fiveHourReservePercent > 0 || sevenDayReservePercent > 0
        ? 'provider_usage_snapshot_hard_stale'
        : null,
      warningReason: null,
      isFresh,
      isSoftStale,
      isHardStale,
      routeDecisionMeta
    };
  }
  if (state.fiveHourContributionCapExhausted) {
    return {
      inScope: true,
      eligible: false,
      exclusionReason: 'contribution_cap_exhausted_5h',
      warningReason: isSoftStale ? 'provider_usage_snapshot_soft_stale' : null,
      isFresh,
      isSoftStale,
      isHardStale,
      routeDecisionMeta
    };
  }
  if (state.sevenDayContributionCapExhausted) {
    return {
      inScope: true,
      eligible: false,
      exclusionReason: 'contribution_cap_exhausted_7d',
      warningReason: isSoftStale ? 'provider_usage_snapshot_soft_stale' : null,
      isFresh,
      isSoftStale,
      isHardStale,
      routeDecisionMeta
    };
  }

  return {
    inScope: true,
    eligible: true,
    exclusionReason: null,
    warningReason: isSoftStale ? 'provider_usage_snapshot_soft_stale' : null,
    isFresh,
    isSoftStale,
    isHardStale,
    routeDecisionMeta
  };
}
