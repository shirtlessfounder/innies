import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import type { ApiKeyRepository } from '../repos/apiKeyRepository.js';
import type {
  AnalyticsDashboardSnapshotPayload,
  DashboardSnapshotStore
} from '../repos/analyticsDashboardSnapshotRepository.js';
import { runtime } from '../services/runtime.js';
import {
  PROVIDER_USAGE_FETCH_BACKOFF_ACTIVE_REASON,
  PROVIDER_USAGE_FETCH_FAILED_REASON,
  readTokenCredentialProviderUsageHardStaleMs,
  readTokenCredentialProviderUsageSoftStaleMs
} from '../services/tokenCredentialProviderUsage.js';
import { evaluateClaudeCredentialAvailability } from '../services/claudeCredentialAvailability.js';
import { deriveDashboardTokenStatusRow } from '../services/dashboardTokenStatus.js';
import { formatDisplayKey, type AnalyticsWindow } from '../utils/analytics.js';
import { AppError } from '../utils/errors.js';

const ANALYTICS_SOURCES = ['openclaw', 'cli-claude', 'cli-codex', 'direct'] as const;
const TOKEN_PROVIDERS = ['anthropic', 'openai'] as const;
const TOKEN_STATUSES = ['active', 'paused', 'rotating', 'maxed', 'expired', 'revoked'] as const;
const ANALYTICS_EVENT_SEVERITIES = ['info', 'warn', 'error'] as const;

type AnalyticsSource = typeof ANALYTICS_SOURCES[number];
type AnalyticsProvider = typeof TOKEN_PROVIDERS[number];
type AnalyticsGranularity = '5m' | '15m' | 'hour' | 'day';
type SourceUsageStats = { requests: number; usageUnits: number };

type TokenUsageFilters = {
  window: AnalyticsWindow;
  provider?: AnalyticsProvider;
  source?: AnalyticsSource;
};

type TokenHealthFilters = {
  window: AnalyticsWindow;
  provider?: AnalyticsProvider;
  source?: AnalyticsSource;
};

type TokenRoutingFilters = {
  window: AnalyticsWindow;
  provider?: AnalyticsProvider;
  source?: AnalyticsSource;
};

type SystemSummaryFilters = {
  window: AnalyticsWindow;
  provider?: AnalyticsProvider;
  source?: AnalyticsSource;
};

type TimeSeriesFilters = {
  window: AnalyticsWindow;
  granularity: AnalyticsGranularity;
  provider?: AnalyticsProvider;
  source?: AnalyticsSource;
  credentialId?: string;
};

type BuyerFilters = {
  window: AnalyticsWindow;
  provider?: AnalyticsProvider;
  source?: AnalyticsSource;
};

type BuyerTimeSeriesFilters = {
  window: AnalyticsWindow;
  granularity: AnalyticsGranularity;
  provider?: AnalyticsProvider;
  source?: AnalyticsSource;
  apiKeyIds?: string[];
};

type RecentRequestsFilters = {
  window: AnalyticsWindow;
  limit: number;
  provider?: AnalyticsProvider;
  source?: AnalyticsSource;
  credentialId?: string;
  model?: string;
  minLatencyMs?: number;
};

type AnomaliesFilters = {
  window: AnalyticsWindow;
  provider?: AnalyticsProvider;
  source?: AnalyticsSource;
};

type EventFilters = {
  window: AnalyticsWindow;
  provider?: AnalyticsProvider;
  limit: number;
};

type DashboardFilters = {
  window: AnalyticsWindow;
  provider?: AnalyticsProvider;
  source?: AnalyticsSource;
};

export interface AnalyticsRouteRepository {
  getTokenUsage(filters: TokenUsageFilters): Promise<unknown>;
  getTokenHealth(filters: TokenHealthFilters): Promise<unknown>;
  getTokenRouting(filters: TokenRoutingFilters): Promise<unknown>;
  getSystemSummary(filters: SystemSummaryFilters): Promise<unknown>;
  getTimeSeries(filters: TimeSeriesFilters): Promise<unknown>;
  getBuyers(filters: BuyerFilters): Promise<unknown>;
  getBuyerTimeSeries(filters: BuyerTimeSeriesFilters): Promise<unknown>;
  getRecentRequests(filters: RecentRequestsFilters): Promise<unknown>;
  getEvents(filters: EventFilters): Promise<unknown>;
  getAnomalies(filters: AnomaliesFilters): Promise<unknown>;
}

type AnalyticsRouteDeps = {
  apiKeys: ApiKeyRepository;
  analytics?: AnalyticsRouteRepository;
  dashboardSnapshots?: DashboardSnapshotStore;
};

const DASHBOARD_SNAPSHOT_FRESHNESS_MS = 2_500;

const analyticsWindowSchema = z.string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['5h', '24h', '7d', '1m', 'all', '30d']))
  .transform((value) => value === '30d' ? '1m' : value);

const analyticsProviderSchema = z.string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['anthropic', 'openai', 'codex']))
  .transform((provider) => provider === 'codex' ? 'openai' : provider);

const analyticsSourceSchema = z.string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(ANALYTICS_SOURCES));

const analyticsGranularitySchema = z.string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['5m', '15m', 'hour', 'day']));

const baseAnalyticsQuerySchema = z.object({
  window: analyticsWindowSchema.optional(),
  provider: analyticsProviderSchema.optional(),
  source: analyticsSourceSchema.optional()
});

const tokenUsageQuerySchema = baseAnalyticsQuerySchema.transform((query) => ({
  window: query.window ?? '24h',
  provider: query.provider,
  source: query.source
}));

const tokenHealthQuerySchema = baseAnalyticsQuerySchema.transform((query) => ({
  window: query.window ?? '7d',
  provider: query.provider,
  source: query.source
}));

const tokenRoutingQuerySchema = baseAnalyticsQuerySchema.transform((query) => ({
  window: query.window ?? '24h',
  provider: query.provider,
  source: query.source
}));

const systemSummaryQuerySchema = baseAnalyticsQuerySchema.transform((query) => ({
  window: query.window ?? '24h',
  provider: query.provider,
  source: query.source
}));

const buyerQuerySchema = baseAnalyticsQuerySchema.transform((query) => ({
  window: query.window ?? '24h',
  provider: query.provider,
  source: query.source
}));

const multiUuidQuerySchema = z.preprocess((value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) return [value];
  return undefined;
}, z.array(z.string().uuid()).optional());

const timeSeriesQuerySchema = baseAnalyticsQuerySchema.extend({
  granularity: analyticsGranularitySchema.optional(),
  credentialId: z.string().uuid().optional()
}).transform((query) => {
  const window = query.window ?? '1m';
  return {
    window,
    provider: query.provider,
    source: query.source,
    credentialId: query.credentialId,
    granularity: query.granularity ?? defaultGranularity(window)
  };
});

const buyerTimeSeriesQuerySchema = baseAnalyticsQuerySchema.extend({
  granularity: analyticsGranularitySchema.optional(),
  apiKeyId: multiUuidQuerySchema
}).transform((query) => {
  const window = query.window ?? '1m';
  return {
    window,
    provider: query.provider,
    source: query.source,
    apiKeyIds: query.apiKeyId,
    granularity: query.granularity ?? defaultGranularity(window)
  };
});

const recentRequestsQuerySchema = baseAnalyticsQuerySchema.extend({
  credentialId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  minLatencyMs: z.coerce.number().int().nonnegative().optional()
}).transform((query) => ({
  window: query.window ?? '24h',
  provider: query.provider,
  source: query.source,
  credentialId: query.credentialId,
  limit: query.limit ?? 50,
  model: query.model,
  minLatencyMs: query.minLatencyMs
}));

const anomaliesQuerySchema = baseAnalyticsQuerySchema.transform((query) => ({
  window: query.window ?? '24h',
  provider: query.provider,
  source: query.source
}));

const eventsQuerySchema = z.object({
  window: analyticsWindowSchema.optional(),
  provider: analyticsProviderSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
}).transform((query) => ({
  window: query.window ?? '24h',
  provider: query.provider,
  limit: query.limit ?? 50
}));

const dashboardQuerySchema = baseAnalyticsQuerySchema.transform((query) => ({
  window: query.window ?? '24h',
  provider: query.provider,
  source: query.source
}));

function defaultGranularity(window: AnalyticsWindow): AnalyticsGranularity {
  switch (window) {
    case '5h':
      return '5m';
    case '24h':
      return '15m';
    case '7d':
      return 'hour';
    case '1m':
    case 'all':
    default:
      return 'day';
  }
}

function missingAnalyticsRepositoryError(): AppError {
  return new AppError('internal_error', 503, 'Analytics repository not configured');
}

async function failMissingRepository(): Promise<never> {
  throw missingAnalyticsRepositoryError();
}

const missingAnalyticsRepository: AnalyticsRouteRepository = {
  getTokenUsage: failMissingRepository as AnalyticsRouteRepository['getTokenUsage'],
  getTokenHealth: failMissingRepository as AnalyticsRouteRepository['getTokenHealth'],
  getTokenRouting: failMissingRepository as AnalyticsRouteRepository['getTokenRouting'],
  getSystemSummary: failMissingRepository as AnalyticsRouteRepository['getSystemSummary'],
  getTimeSeries: failMissingRepository as AnalyticsRouteRepository['getTimeSeries'],
  getBuyers: failMissingRepository as AnalyticsRouteRepository['getBuyers'],
  getBuyerTimeSeries: failMissingRepository as AnalyticsRouteRepository['getBuyerTimeSeries'],
  getRecentRequests: failMissingRepository as AnalyticsRouteRepository['getRecentRequests'],
  getEvents: failMissingRepository as AnalyticsRouteRepository['getEvents'],
  getAnomalies: failMissingRepository as AnalyticsRouteRepository['getAnomalies']
};

function readObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('internal_error', 500, `Analytics repository returned invalid ${field}`);
  }
  return value as Record<string, unknown>;
}

function readObjectArray(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new AppError('internal_error', 500, `Analytics repository returned invalid ${field}`);
  }

  return value.map((entry, index) => readObject(entry, `${field}[${index}]`));
}

function pick(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readRequiredString(record: Record<string, unknown>, keys: string[], field: string): string {
  const value = readTrimmedString(pick(record, keys));
  if (!value) {
    throw new AppError('internal_error', 500, `Analytics repository returned invalid ${field}`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, keys: string[]): string | null {
  return readTrimmedString(pick(record, keys));
}

function readNumberLike(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readRequiredNumber(record: Record<string, unknown>, keys: string[], field: string): number {
  const value = readNumberLike(pick(record, keys));
  if (value === null) {
    throw new AppError('internal_error', 500, `Analytics repository returned invalid ${field}`);
  }
  return value;
}

function readOptionalNumber(record: Record<string, unknown>, keys: string[], fallback: number | null = null): number | null {
  const value = readNumberLike(pick(record, keys));
  return value === null ? fallback : value;
}

function readBooleanLike(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

function readOptionalBoolean(record: Record<string, unknown>, keys: string[], fallback = false): boolean {
  const value = readBooleanLike(pick(record, keys));
  return value === null ? fallback : value;
}

function readNullableBoolean(record: Record<string, unknown>, keys: string[]): boolean | null {
  return readBooleanLike(pick(record, keys));
}

function readIsoDate(value: unknown, field: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim().length > 0) {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  throw new AppError('internal_error', 500, `Analytics repository returned invalid ${field}`);
}

function readOptionalIsoDate(record: Record<string, unknown>, keys: string[]): string | null {
  const value = pick(record, keys);
  if (value === null || value === undefined) return null;
  return readIsoDate(value, keys[0] ?? 'date');
}

function normalizeProvider(value: unknown, field: string): AnalyticsProvider {
  const normalized = readTrimmedString(value)?.toLowerCase();
  if (normalized === 'codex') return 'openai';
  if (normalized === 'anthropic' || normalized === 'openai') return normalized;
  throw new AppError('internal_error', 500, `Analytics repository returned invalid ${field}`);
}

function normalizeOptionalProvider(value: unknown): AnalyticsProvider | null {
  if (value === null || value === undefined) return null;
  return normalizeProvider(value, 'provider');
}

function normalizeTokenStatus(value: unknown, field: string): typeof TOKEN_STATUSES[number] {
  const normalized = readTrimmedString(value)?.toLowerCase();
  if (normalized && (TOKEN_STATUSES as readonly string[]).includes(normalized)) {
    return normalized as typeof TOKEN_STATUSES[number];
  }
  throw new AppError('internal_error', 500, `Analytics repository returned invalid ${field}`);
}

function coerceExpiredTokenStatus(
  status: typeof TOKEN_STATUSES[number],
  expiresAt: string | null
): typeof TOKEN_STATUSES[number] {
  if (status === 'expired' || status === 'revoked') return status;
  if (!expiresAt) return status;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return status;
  return expiresAtMs <= Date.now()
    ? 'expired'
    : status;
}

function deriveDashboardSummaryFromTokens(
  summary: ReturnType<typeof normalizeSystemSummary>,
  tokens: Array<Record<string, unknown>>,
  hadTokenRows: boolean
) {
  if (!hadTokenRows && tokens.length === 0) {
    return summary;
  }

  const maxedTokens = tokens.filter((row) => {
    const status = readTrimmedString((row as { status?: unknown }).status) ?? 'unknown';
    return status.toLowerCase() === 'maxed';
  }).length;

  return {
    ...summary,
    activeTokens: tokens.length - maxedTokens,
    maxedTokens,
    totalTokens: tokens.length
  };
}

function normalizeEventSeverity(value: unknown): typeof ANALYTICS_EVENT_SEVERITIES[number] {
  const normalized = readTrimmedString(value)?.toLowerCase();
  if (normalized && (ANALYTICS_EVENT_SEVERITIES as readonly string[]).includes(normalized)) {
    return normalized as typeof ANALYTICS_EVENT_SEVERITIES[number];
  }
  return 'info';
}

function readJsonRecord(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const value = pick(record, keys);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeSourceValue(value: unknown): AnalyticsSource | null {
  const normalized = readTrimmedString(value)?.toLowerCase();
  if (normalized && (ANALYTICS_SOURCES as readonly string[]).includes(normalized)) {
    return normalized as AnalyticsSource;
  }
  return null;
}

function emptySourceBreakdown(): Record<AnalyticsSource, SourceUsageStats> {
  return {
    openclaw: { requests: 0, usageUnits: 0 },
    'cli-claude': { requests: 0, usageUnits: 0 },
    'cli-codex': { requests: 0, usageUnits: 0 },
    direct: { requests: 0, usageUnits: 0 }
  };
}

function normalizeSourceBreakdown(value: unknown): Record<AnalyticsSource, SourceUsageStats> {
  const breakdown = emptySourceBreakdown();

  if (!value) return breakdown;

  if (Array.isArray(value)) {
    for (const entry of value) {
      const record = readObject(entry, 'bySource entry');
      const source = normalizeSourceValue(pick(record, ['source', 'key', 'name']));
      if (!source) continue;
      breakdown[source] = {
        requests: readOptionalNumber(record, ['requests', 'request_count'], 0) ?? 0,
        usageUnits: readOptionalNumber(record, ['usageUnits', 'usage_units'], 0) ?? 0
      };
    }
    return breakdown;
  }

  const record = readObject(value, 'bySource');
  for (const source of ANALYTICS_SOURCES) {
    if (!(source in record)) continue;
    const sourceRecord = readObject(record[source], `bySource.${source}`);
    breakdown[source] = {
      requests: readOptionalNumber(sourceRecord, ['requests', 'request_count'], 0) ?? 0,
      usageUnits: readOptionalNumber(sourceRecord, ['usageUnits', 'usage_units'], 0) ?? 0
    };
  }
  return breakdown;
}

function normalizeBreakdownMap(value: unknown, keyFieldCandidates: string[]): Record<string, SourceUsageStats> {
  if (!value) return {};

  if (Array.isArray(value)) {
    const entries: Array<[string, SourceUsageStats]> = [];
    for (const item of value) {
      const record = readObject(item, 'breakdown entry');
      const key = readOptionalString(record, keyFieldCandidates);
      if (!key) continue;
      entries.push([key, {
        requests: readOptionalNumber(record, ['requests', 'request_count'], 0) ?? 0,
        usageUnits: readOptionalNumber(record, ['usageUnits', 'usage_units'], 0) ?? 0
      }]);
    }
    return Object.fromEntries(entries);
  }

  const record = readObject(value, 'breakdown');
  const entries: Array<[string, SourceUsageStats]> = [];
  for (const [key, raw] of Object.entries(record)) {
    const entry = readObject(raw, `breakdown.${key}`);
    entries.push([key, {
      requests: readOptionalNumber(entry, ['requests', 'request_count'], 0) ?? 0,
      usageUnits: readOptionalNumber(entry, ['usageUnits', 'usage_units'], 0) ?? 0
    }]);
  }
  return Object.fromEntries(entries);
}

function normalizeErrorBreakdown(value: unknown): Record<string, number> {
  if (!value) return {};

  const entries: Array<[string, number]> = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      const record = readObject(item, 'errorBreakdown entry');
      const key = readOptionalString(record, ['code', 'status', 'errorCode', 'error_code', 'key']);
      if (!key) continue;
      entries.push([key, readOptionalNumber(record, ['count', 'value'], 0) ?? 0]);
    }
  } else {
    const record = readObject(value, 'errorBreakdown');
    for (const [key, raw] of Object.entries(record)) {
      const count = readNumberLike(raw);
      entries.push([key, count ?? 0]);
    }
  }

  entries.sort(([left], [right]) => left.localeCompare(right, 'en'));
  return Object.fromEntries(entries);
}

function normalizeTokenUsageRows(value: unknown) {
  return readObjectArray(value, 'tokens').map((record) => ({
    credentialId: readRequiredString(record, ['credentialId', 'credential_id'], 'credentialId'),
    displayKey: readOptionalString(record, ['displayKey', 'display_key']) ?? formatDisplayKey(
      readRequiredString(record, ['credentialId', 'credential_id'], 'credentialId'),
      'cred'
    ),
    debugLabel: readOptionalString(record, ['debugLabel', 'debug_label']),
    provider: normalizeProvider(pick(record, ['provider']), 'provider'),
    status: normalizeTokenStatus(pick(record, ['status']), 'status'),
    attempts: readOptionalNumber(record, ['attempts', 'attempt_count'], 0) ?? 0,
    requests: readRequiredNumber(record, ['requests', 'request_count'], 'requests'),
    usageUnits: readRequiredNumber(record, ['usageUnits', 'usage_units'], 'usageUnits'),
    retailEquivalentMinor: readOptionalNumber(record, ['retailEquivalentMinor', 'retail_equivalent_minor'], 0) ?? 0,
    inputTokens: readOptionalNumber(record, ['inputTokens', 'input_tokens'], 0) ?? 0,
    outputTokens: readOptionalNumber(record, ['outputTokens', 'output_tokens'], 0) ?? 0,
    bySource: normalizeSourceBreakdown(pick(record, ['bySource', 'by_source']))
  }));
}

function normalizeTokenHealthRows(value: unknown) {
  return readObjectArray(value, 'tokens').map((record) => {
    const credentialId = readRequiredString(record, ['credentialId', 'credential_id'], 'credentialId');
    const expiresAt = readOptionalIsoDate(record, ['expiresAt', 'expires_at']);
    const status = coerceExpiredTokenStatus(
      normalizeTokenStatus(pick(record, ['status']), 'status'),
      expiresAt
    );

    return {
      credentialId,
      displayKey: readOptionalString(record, ['displayKey', 'display_key']) ?? formatDisplayKey(
        credentialId,
        'cred'
      ),
      debugLabel: readOptionalString(record, ['debugLabel', 'debug_label']),
      provider: normalizeProvider(pick(record, ['provider']), 'provider'),
      status,
      ...(readOptionalString(record, ['authDiagnosis', 'auth_diagnosis']) !== null
        ? { authDiagnosis: readOptionalString(record, ['authDiagnosis', 'auth_diagnosis']) }
        : {}),
      ...(readOptionalIsoDate(record, ['accessTokenExpiresAt', 'access_token_expires_at']) !== null
        ? { accessTokenExpiresAt: readOptionalIsoDate(record, ['accessTokenExpiresAt', 'access_token_expires_at']) }
        : {}),
      ...(readOptionalString(record, ['refreshTokenState', 'refresh_token_state']) !== null
        ? { refreshTokenState: readOptionalString(record, ['refreshTokenState', 'refresh_token_state']) }
        : {}),
      consecutiveFailures: readOptionalNumber(record, ['consecutiveFailures', 'consecutive_failure_count'], 0) ?? 0,
      consecutiveRateLimitCount: readOptionalNumber(record, ['consecutiveRateLimitCount', 'consecutive_rate_limit_count'], 0) ?? 0,
      lastFailedStatus: readOptionalNumber(record, ['lastFailedStatus', 'last_failed_status']),
      lastFailedAt: readOptionalIsoDate(record, ['lastFailedAt', 'last_failed_at']),
      lastRateLimitedAt: readOptionalIsoDate(record, ['lastRateLimitedAt', 'last_rate_limited_at']),
      maxedAt: readOptionalIsoDate(record, ['maxedAt', 'maxed_at']),
      rateLimitedUntil: readOptionalIsoDate(record, ['rateLimitedUntil', 'rate_limited_until']),
      nextProbeAt: readOptionalIsoDate(record, ['nextProbeAt', 'next_probe_at']),
      lastProbeAt: readOptionalIsoDate(record, ['lastProbeAt', 'last_probe_at']),
      monthlyContributionLimitUnits: readOptionalNumber(record, ['monthlyContributionLimitUnits', 'monthly_contribution_limit_units']),
      monthlyContributionUsedUnits: readOptionalNumber(record, ['monthlyContributionUsedUnits', 'monthly_contribution_used_units'], 0) ?? 0,
      monthlyWindowStartAt: readOptionalIsoDate(record, ['monthlyWindowStartAt', 'monthly_window_start_at']),
      maxedEvents7d: readOptionalNumber(record, ['maxedEvents7d', 'maxed_events_7d'], 0) ?? 0,
      requestsBeforeMaxedLastWindow: readOptionalNumber(record, ['requestsBeforeMaxedLastWindow', 'requests_before_maxed_last_window']),
      avgRequestsBeforeMaxed: readOptionalNumber(record, ['avgRequestsBeforeMaxed', 'avg_requests_before_maxed']),
      avgUsageUnitsBeforeMaxed: readOptionalNumber(record, ['avgUsageUnitsBeforeMaxed', 'avg_usage_units_before_maxed']),
      avgRecoveryTimeMs: readOptionalNumber(record, ['avgRecoveryTimeMs', 'avg_recovery_time_ms']),
      estimatedDailyCapacityUnits: readOptionalNumber(record, ['estimatedDailyCapacityUnits', 'estimated_daily_capacity_units']),
      maxingCyclesObserved: readOptionalNumber(record, ['maxingCyclesObserved', 'maxing_cycles_observed']),
      utilizationRate24h: readOptionalNumber(record, ['utilizationRate24h', 'utilization_rate_24h']),
      fiveHourReservePercent: readOptionalNumber(record, ['fiveHourReservePercent', 'five_hour_reserve_percent']),
      fiveHourUtilizationRatio: readOptionalNumber(record, ['fiveHourUtilizationRatio', 'five_hour_utilization_ratio']),
      fiveHourResetsAt: readOptionalIsoDate(record, ['fiveHourResetsAt', 'five_hour_resets_at']),
      fiveHourContributionCapExhausted: readNullableBoolean(
        record,
        ['fiveHourContributionCapExhausted', 'five_hour_contribution_cap_exhausted']
      ),
      sevenDayReservePercent: readOptionalNumber(record, ['sevenDayReservePercent', 'seven_day_reserve_percent']),
      sevenDayUtilizationRatio: readOptionalNumber(record, ['sevenDayUtilizationRatio', 'seven_day_utilization_ratio']),
      sevenDayResetsAt: readOptionalIsoDate(record, ['sevenDayResetsAt', 'seven_day_resets_at']),
      sevenDayContributionCapExhausted: readNullableBoolean(
        record,
        ['sevenDayContributionCapExhausted', 'seven_day_contribution_cap_exhausted']
      ),
      providerUsageFetchedAt: readOptionalIsoDate(record, ['providerUsageFetchedAt', 'provider_usage_fetched_at']),
      claudeFiveHourCapExhaustionCyclesObserved: readOptionalNumber(
        record,
        ['claudeFiveHourCapExhaustionCyclesObserved', 'claude_five_hour_cap_exhaustion_cycles_observed']
      ),
      claudeFiveHourUsageUnitsBeforeCapExhaustionLastWindow: readOptionalNumber(
        record,
        [
          'claudeFiveHourUsageUnitsBeforeCapExhaustionLastWindow',
          'claude_five_hour_usage_units_before_cap_exhaustion_last_window'
        ]
      ),
      claudeFiveHourAvgUsageUnitsBeforeCapExhaustion: readOptionalNumber(
        record,
        ['claudeFiveHourAvgUsageUnitsBeforeCapExhaustion', 'claude_five_hour_avg_usage_units_before_cap_exhaustion']
      ),
      claudeSevenDayCapExhaustionCyclesObserved: readOptionalNumber(
        record,
        ['claudeSevenDayCapExhaustionCyclesObserved', 'claude_seven_day_cap_exhaustion_cycles_observed']
      ),
      claudeSevenDayUsageUnitsBeforeCapExhaustionLastWindow: readOptionalNumber(
        record,
        [
          'claudeSevenDayUsageUnitsBeforeCapExhaustionLastWindow',
          'claude_seven_day_usage_units_before_cap_exhaustion_last_window'
        ]
      ),
      claudeSevenDayAvgUsageUnitsBeforeCapExhaustion: readOptionalNumber(
        record,
        ['claudeSevenDayAvgUsageUnitsBeforeCapExhaustion', 'claude_seven_day_avg_usage_units_before_cap_exhaustion']
      ),
      createdAt: readOptionalIsoDate(record, ['createdAt', 'created_at']),
      expiresAt
    };
  });
}

function normalizeProviderUsageWarningRows(value: unknown) {
  return readObjectArray(value, 'tokens').map((record) => {
    const credentialId = readRequiredString(record, ['credentialId', 'credential_id'], 'credentialId');
    const expiresAt = readOptionalIsoDate(record, ['expiresAt', 'expires_at']);
    return {
      credentialId,
      displayKey: readOptionalString(record, ['displayKey', 'display_key']) ?? formatDisplayKey(credentialId, 'cred'),
      debugLabel: readOptionalString(record, ['debugLabel', 'debug_label']),
      provider: normalizeProvider(pick(record, ['provider']), 'provider'),
      status: coerceExpiredTokenStatus(
        normalizeTokenStatus(pick(record, ['status']), 'status'),
        expiresAt
      ),
      consecutiveFailures: readOptionalNumber(record, ['consecutiveFailures', 'consecutive_failure_count'], 0) ?? 0,
      consecutiveRateLimitCount: readOptionalNumber(record, ['consecutiveRateLimitCount', 'consecutive_rate_limit_count'], 0) ?? 0,
      lastFailedStatus: readOptionalNumber(record, ['lastFailedStatus', 'last_failed_status']),
      rateLimitedUntil: readOptionalIsoDate(record, ['rateLimitedUntil', 'rate_limited_until']),
      nextProbeAt: readOptionalIsoDate(record, ['nextProbeAt', 'next_probe_at']),
      fiveHourUtilizationRatio: readOptionalNumber(record, ['fiveHourUtilizationRatio', 'five_hour_utilization_ratio']),
      fiveHourReservePercent: readOptionalNumber(record, ['fiveHourReservePercent', 'five_hour_reserve_percent']),
      fiveHourResetsAt: readOptionalIsoDate(record, ['fiveHourResetsAt', 'five_hour_resets_at']),
      fiveHourContributionCapExhausted: readNullableBoolean(
        record,
        ['fiveHourContributionCapExhausted', 'five_hour_contribution_cap_exhausted']
      ),
      sevenDayUtilizationRatio: readOptionalNumber(record, ['sevenDayUtilizationRatio', 'seven_day_utilization_ratio']),
      sevenDayReservePercent: readOptionalNumber(record, ['sevenDayReservePercent', 'seven_day_reserve_percent']),
      sevenDayResetsAt: readOptionalIsoDate(record, ['sevenDayResetsAt', 'seven_day_resets_at']),
      sevenDayContributionCapExhausted: readNullableBoolean(
        record,
        ['sevenDayContributionCapExhausted', 'seven_day_contribution_cap_exhausted']
      ),
      providerUsageFetchedAt: readOptionalIsoDate(record, ['providerUsageFetchedAt', 'provider_usage_fetched_at']),
      lastRefreshError: readOptionalString(record, ['lastRefreshError', 'last_refresh_error'])
    };
  });
}

function normalizeWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => readTrimmedString(entry))
    .filter((entry): entry is string => entry !== null);
}

function tokenHealthWarningLabel(row: {
  credentialId: string;
  displayKey: string | null;
  debugLabel: string | null;
}): string {
  return row.debugLabel ?? row.displayKey ?? row.credentialId;
}

function formatWarningAge(ageMs: number): string {
  const totalMinutes = Math.max(1, Math.round(ageMs / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.round((ageMs / 60_000 / 60) * 10) / 10;
  if (totalHours < 24) return `${totalHours}h`;
  const totalDays = Math.round((ageMs / 60_000 / 60 / 24) * 10) / 10;
  return `${totalDays}d`;
}

function appendDashboardWarning(
  warnings: string[],
  seen: Set<string>,
  warning: string
): void {
  if (seen.has(warning)) return;
  seen.add(warning);
  warnings.push(warning);
}

function openAiUsageExhausted(row: {
  fiveHourUtilizationRatio: number | null;
  sevenDayUtilizationRatio: number | null;
}) {
  return {
    fiveHour: (row.fiveHourUtilizationRatio ?? 0) >= 1,
    sevenDay: (row.sevenDayUtilizationRatio ?? 0) >= 1
  };
}

function buildProviderUsageWarnings(
  rawTokenHealthRows: unknown,
  now = Date.now()
): string[] {
  const tokenHealthRows = normalizeProviderUsageWarningRows(rawTokenHealthRows);
  const warnings: string[] = [];
  const seen = new Set<string>();
  const softStaleMs = readTokenCredentialProviderUsageSoftStaleMs();
  const hardStaleMs = readTokenCredentialProviderUsageHardStaleMs();

  for (const row of tokenHealthRows) {
    if (row.status === 'expired' || row.status === 'revoked') continue;

    const label = tokenHealthWarningLabel(row);
    if (row.provider === 'openai') {
      const fetchedAtRaw = row.providerUsageFetchedAt;

      if (row.lastRefreshError === PROVIDER_USAGE_FETCH_FAILED_REASON) {
        appendDashboardWarning(
          warnings,
          seen,
          `${label}: provider_usage_fetch_failed - last Codex usage refresh failed; dashboard usage state may lag until a successful refresh.`
        );
      } else if (row.lastRefreshError === PROVIDER_USAGE_FETCH_BACKOFF_ACTIVE_REASON) {
        appendDashboardWarning(
          warnings,
          seen,
          `${label}: provider_usage_fetch_backoff_active - Codex usage refresh is temporarily backing off after recent fetch failures; dashboard usage state may lag until retry.`
        );
      }

      if (!fetchedAtRaw) {
        appendDashboardWarning(
          warnings,
          seen,
          `${label}: provider_usage_snapshot_missing - Codex token has no provider-usage snapshot yet; dashboard usage state may lag until one arrives.`
        );
        continue;
      }

      const fetchedAtMs = Date.parse(fetchedAtRaw);
      const ageMs = Number.isFinite(fetchedAtMs) ? Math.max(0, now - fetchedAtMs) : null;

      if (ageMs !== null && ageMs > hardStaleMs) {
        appendDashboardWarning(
          warnings,
          seen,
          `${label}: provider_usage_snapshot_hard_stale - last Codex usage snapshot is ${formatWarningAge(ageMs)} old; dashboard usage state may lag until a fresh snapshot arrives.`
        );
        continue;
      }

      if (ageMs !== null && ageMs > softStaleMs) {
        appendDashboardWarning(
          warnings,
          seen,
          `${label}: provider_usage_snapshot_soft_stale - last Codex usage snapshot is ${formatWarningAge(ageMs)} old; dashboard is still using the last successful snapshot.`
        );
      }

      const exhausted = openAiUsageExhausted(row);
      if (exhausted.fiveHour) {
        appendDashboardWarning(
          warnings,
          seen,
          `${label}: usage_exhausted_5h - Codex usage is exhausted for the 5h window${row.fiveHourResetsAt ? ` until ${row.fiveHourResetsAt}` : ''}.`
        );
      }

      if (exhausted.sevenDay) {
        appendDashboardWarning(
          warnings,
          seen,
          `${label}: usage_exhausted_7d - Codex usage is exhausted for the 7d window${row.sevenDayResetsAt ? ` until ${row.sevenDayResetsAt}` : ''}.`
        );
      }

      continue;
    }

    if (row.provider !== 'anthropic') continue;

    const availability = evaluateClaudeCredentialAvailability({
      credential: {
        provider: row.provider,
        status: row.status,
        fiveHourReservePercent: row.fiveHourReservePercent,
        sevenDayReservePercent: row.sevenDayReservePercent,
        consecutiveFailureCount: row.consecutiveFailures,
        consecutiveRateLimitCount: row.consecutiveRateLimitCount,
        lastFailedStatus: row.lastFailedStatus,
        rateLimitedUntil: row.rateLimitedUntil,
        nextProbeAt: row.nextProbeAt
      },
      snapshot: {
        fetchedAt: row.providerUsageFetchedAt,
        fiveHourUtilizationRatio: row.fiveHourUtilizationRatio,
        fiveHourResetsAt: row.fiveHourResetsAt,
        sevenDayUtilizationRatio: row.sevenDayUtilizationRatio,
        sevenDayResetsAt: row.sevenDayResetsAt
      },
      now: new Date(now)
    });
    const reserveConfigured = availability.reserveConfigured;
    const fetchedAtRaw = row.providerUsageFetchedAt;

    if (availability.authFailed) {
      appendDashboardWarning(
        warnings,
        seen,
        availability.nextCheckAt
          ? `${label}: auth_failed - Claude credential is parked after upstream ${row.lastFailedStatus ?? 'auth'} failures; next probe at ${availability.nextCheckAt.toISOString()}.`
          : `${label}: auth_failed - Claude credential is parked after upstream ${row.lastFailedStatus ?? 'auth'} failures.`
      );
      continue;
    }

    if (row.lastRefreshError === PROVIDER_USAGE_FETCH_FAILED_REASON) {
      appendDashboardWarning(
        warnings,
        seen,
        `${label}: provider_usage_fetch_failed - last Claude usage refresh failed; dashboard freshness/cap state may lag until a successful refresh.`
      );
    } else if (row.lastRefreshError === PROVIDER_USAGE_FETCH_BACKOFF_ACTIVE_REASON) {
      appendDashboardWarning(
        warnings,
        seen,
        `${label}: provider_usage_fetch_backoff_active - Claude usage refresh is temporarily backing off after recent fetch failures; dashboard freshness/cap state may lag until retry.`
      );
    }

    if (!fetchedAtRaw) {
      if (reserveConfigured) {
        appendDashboardWarning(
          warnings,
          seen,
          `${label}: provider_usage_snapshot_missing - reserved Claude token has no provider-usage snapshot yet; pooled routing excludes it until one arrives.`
        );
      }
      continue;
    }

    const fetchedAtMs = Date.parse(fetchedAtRaw);
    const ageMs = Number.isFinite(fetchedAtMs) ? Math.max(0, now - fetchedAtMs) : null;
    if (
      ageMs !== null
      && ageMs > hardStaleMs
      && !availability.fiveHourProviderUsageHoldActive
      && !availability.sevenDayProviderUsageHoldActive
    ) {
      appendDashboardWarning(
        warnings,
        seen,
        reserveConfigured
          ? `${label}: provider_usage_snapshot_hard_stale - last Claude usage snapshot is ${formatWarningAge(ageMs)} old; pooled routing excludes this reserved token until a fresh snapshot arrives.`
          : `${label}: provider_usage_snapshot_hard_stale - last Claude usage snapshot is ${formatWarningAge(ageMs)} old; routing is currently fail-open because both reserves are 0%.`
      );
      continue;
    }

    if (
      ageMs !== null
      && ageMs > softStaleMs
      && !availability.fiveHourProviderUsageHoldActive
      && !availability.sevenDayProviderUsageHoldActive
    ) {
      appendDashboardWarning(
        warnings,
        seen,
        `${label}: provider_usage_snapshot_soft_stale - last Claude usage snapshot is ${formatWarningAge(ageMs)} old; routing is still using the last successful snapshot.`
      );
    }

    if (availability.fiveHourContributionCapExhausted) {
      appendDashboardWarning(
        warnings,
        seen,
        `${label}: usage_exhausted_5h - pooled Claude routing is at the 5h cap${row.fiveHourResetsAt ? ` until ${row.fiveHourResetsAt}` : ''}.`
      );
    }

    if (availability.sevenDayContributionCapExhausted) {
      appendDashboardWarning(
        warnings,
        seen,
        `${label}: usage_exhausted_7d - pooled Claude routing is at the 7d cap${row.sevenDayResetsAt ? ` until ${row.sevenDayResetsAt}` : ''}.`
      );
    }
  }

  return warnings;
}

function normalizeTokenRoutingRows(value: unknown) {
  return readObjectArray(value, 'tokens').map((record) => ({
    credentialId: readRequiredString(record, ['credentialId', 'credential_id'], 'credentialId'),
    displayKey: readOptionalString(record, ['displayKey', 'display_key']) ?? formatDisplayKey(
      readRequiredString(record, ['credentialId', 'credential_id'], 'credentialId'),
      'cred'
    ),
    debugLabel: readOptionalString(record, ['debugLabel', 'debug_label', 'credentialLabel', 'credential_label']),
    provider: normalizeProvider(pick(record, ['provider']), 'provider'),
    totalAttempts: readOptionalNumber(record, ['totalAttempts', 'total_attempts'], 0) ?? 0,
    successCount: readOptionalNumber(record, ['successCount', 'success_count'], 0) ?? 0,
    errorCount: readOptionalNumber(record, ['errorCount', 'error_count'], 0) ?? 0,
    errorBreakdown: normalizeErrorBreakdown(pick(record, ['errorBreakdown', 'error_breakdown'])),
    latencyP50Ms: readOptionalNumber(record, ['latencyP50Ms', 'latency_p50_ms']),
    latencyP95Ms: readOptionalNumber(record, ['latencyP95Ms', 'latency_p95_ms']),
    ttfbP50Ms: readOptionalNumber(record, ['ttfbP50Ms', 'ttfb_p50_ms']),
    ttfbP95Ms: readOptionalNumber(record, ['ttfbP95Ms', 'ttfb_p95_ms']),
    fallbackCount: readOptionalNumber(record, ['fallbackCount', 'fallback_count'], 0) ?? 0,
    authFailures24h: readOptionalNumber(record, ['authFailures24h', 'auth_failures_24h'], 0) ?? 0,
    rateLimited24h: readOptionalNumber(record, ['rateLimited24h', 'rate_limited_24h'], 0) ?? 0
  }));
}

function normalizeTranslationOverhead(value: unknown) {
  if (value === null || value === undefined) return null;

  const record = readObject(value, 'translationOverhead');
  return {
    directLatencyP50Ms: readOptionalNumber(record, ['directLatencyP50Ms', 'direct_latency_p50_ms']),
    directLatencyP95Ms: readOptionalNumber(record, ['directLatencyP95Ms', 'direct_latency_p95_ms']),
    translatedLatencyP50Ms: readOptionalNumber(record, ['translatedLatencyP50Ms', 'translated_latency_p50_ms']),
    translatedLatencyP95Ms: readOptionalNumber(record, ['translatedLatencyP95Ms', 'translated_latency_p95_ms']),
    translatedRequestCount: readOptionalNumber(record, ['translatedRequestCount', 'translated_request_count']),
    directRequestCount: readOptionalNumber(record, ['directRequestCount', 'direct_request_count'])
  };
}

function normalizeSystemSummary(value: unknown) {
  const record = readObject(value, 'system summary');

  return {
    totalRequests: readOptionalNumber(record, ['totalRequests', 'total_requests'], 0) ?? 0,
    totalUsageUnits: readOptionalNumber(record, ['totalUsageUnits', 'total_usage_units'], 0) ?? 0,
    byProvider: normalizeBreakdownMap(pick(record, ['byProvider', 'by_provider']), ['provider', 'key', 'name']),
    byModel: normalizeBreakdownMap(pick(record, ['byModel', 'by_model']), ['model', 'key', 'name']),
    latencyP50Ms: readOptionalNumber(record, ['latencyP50Ms', 'latency_p50_ms']),
    latencyP95Ms: readOptionalNumber(record, ['latencyP95Ms', 'latency_p95_ms']),
    ttfbP50Ms: readOptionalNumber(record, ['ttfbP50Ms', 'ttfb_p50_ms']),
    ttfbP95Ms: readOptionalNumber(record, ['ttfbP95Ms', 'ttfb_p95_ms']),
    errorRate: readOptionalNumber(record, ['errorRate', 'error_rate'], 0) ?? 0,
    fallbackRate: readOptionalNumber(record, ['fallbackRate', 'fallback_rate'], 0) ?? 0,
    activeTokens: readOptionalNumber(record, ['activeTokens', 'active_tokens'], 0) ?? 0,
    maxedTokens: readOptionalNumber(record, ['maxedTokens', 'maxed_tokens'], 0) ?? 0,
    totalTokens: readOptionalNumber(record, ['totalTokens', 'total_tokens'], 0) ?? 0,
    maxedEvents7d: readOptionalNumber(record, ['maxedEvents7d', 'maxed_events_7d'], 0) ?? 0,
    bySource: normalizeSourceBreakdown(pick(record, ['bySource', 'by_source'])),
    translationOverhead: normalizeTranslationOverhead(pick(record, ['translationOverhead', 'translation_overhead'])),
    topBuyers: readObjectArray(pick(record, ['topBuyers', 'top_buyers']) ?? [], 'topBuyers').map((buyer) => ({
      apiKeyId: readRequiredString(buyer, ['apiKeyId', 'api_key_id'], 'topBuyers.apiKeyId'),
      orgId: readRequiredString(buyer, ['orgId', 'org_id'], 'topBuyers.orgId'),
      requests: readOptionalNumber(buyer, ['requests', 'request_count'], 0) ?? 0,
      usageUnits: readOptionalNumber(buyer, ['usageUnits', 'usage_units'], 0) ?? 0,
      percentOfTotal: readOptionalNumber(buyer, ['percentOfTotal', 'percent_of_total'], 0) ?? 0
    }))
  };
}

function normalizeTimeSeries(value: unknown) {
  return readObjectArray(value, 'series').map((record) => ({
    date: readIsoDate(pick(record, ['date', 'bucket', 'bucketStartAt', 'bucket_start_at']), 'series.date'),
    requests: readOptionalNumber(record, ['requests', 'request_count'], 0) ?? 0,
    usageUnits: readOptionalNumber(record, ['usageUnits', 'usage_units'], 0) ?? 0,
    errorRate: readOptionalNumber(record, ['errorRate', 'error_rate'], 0) ?? 0,
    latencyP50Ms: readOptionalNumber(record, ['latencyP50Ms', 'latency_p50_ms'])
  }));
}

function normalizeBuyerRows(value: unknown) {
  return readObjectArray(value, 'buyers').map((record) => {
    const apiKeyId = readRequiredString(record, ['apiKeyId', 'api_key_id'], 'apiKeyId');
    return {
      apiKeyId,
      displayKey: readOptionalString(record, ['displayKey', 'display_key']) ?? formatDisplayKey(apiKeyId, 'key'),
      label: readRequiredString(record, ['label', 'name'], 'label'),
      orgId: readOptionalString(record, ['orgId', 'org_id']),
      orgLabel: readOptionalString(record, ['orgLabel', 'org_label', 'orgName', 'org_name']),
      preferredProvider: normalizeOptionalProvider(pick(record, ['preferredProvider', 'preferred_provider'])),
      effectiveProvider: normalizeProvider(pick(record, ['effectiveProvider', 'effective_provider']), 'effectiveProvider'),
      requests: readOptionalNumber(record, ['requests', 'request_count'], 0) ?? 0,
      attempts: readOptionalNumber(record, ['attempts', 'attempt_count'], 0) ?? 0,
      usageUnits: readOptionalNumber(record, ['usageUnits', 'usage_units'], 0) ?? 0,
      retailEquivalentMinor: readOptionalNumber(record, ['retailEquivalentMinor', 'retail_equivalent_minor'], 0) ?? 0,
      percentOfTotal: readOptionalNumber(record, ['percentOfTotal', 'percent_of_total'], 0) ?? 0,
      lastSeenAt: readOptionalIsoDate(record, ['lastSeenAt', 'last_seen_at']),
      latencyP50Ms: readOptionalNumber(record, ['latencyP50Ms', 'latency_p50_ms']),
      errorRate: readOptionalNumber(record, ['errorRate', 'error_rate'], 0) ?? 0,
      bySource: normalizeSourceBreakdown(pick(record, ['bySource', 'by_source']))
    };
  });
}

function normalizeBuyerTimeSeries(value: unknown) {
  return readObjectArray(value, 'series').map((record) => ({
    date: readIsoDate(pick(record, ['date', 'bucket', 'bucketStartAt', 'bucket_start_at']), 'series.date'),
    apiKeyId: readRequiredString(record, ['apiKeyId', 'api_key_id'], 'series.apiKeyId'),
    requests: readOptionalNumber(record, ['requests', 'request_count'], 0) ?? 0,
    usageUnits: readOptionalNumber(record, ['usageUnits', 'usage_units'], 0) ?? 0,
    errorRate: readOptionalNumber(record, ['errorRate', 'error_rate'], 0) ?? 0,
    latencyP50Ms: readOptionalNumber(record, ['latencyP50Ms', 'latency_p50_ms'])
  }));
}

function normalizeRecentRequests(value: unknown) {
  return readObjectArray(value, 'requests').map((record) => ({
    requestId: readRequiredString(record, ['requestId', 'request_id'], 'requestId'),
    attemptNo: readOptionalNumber(record, ['attemptNo', 'attempt_no'], 1) ?? 1,
    createdAt: readIsoDate(pick(record, ['createdAt', 'created_at']), 'createdAt'),
    credentialId: readOptionalString(record, ['credentialId', 'credential_id']),
    credentialLabel: readOptionalString(record, ['credentialLabel', 'credential_label', 'debugLabel', 'debug_label']),
    provider: normalizeProvider(pick(record, ['provider']), 'provider'),
    model: readRequiredString(record, ['model'], 'model'),
    source: normalizeSourceValue(pick(record, ['source'])) ?? 'direct',
    translated: readOptionalBoolean(record, ['translated'], false),
    rescued: readOptionalBoolean(record, ['rescued'], false),
    rescueScope: readOptionalString(record, ['rescueScope', 'rescue_scope']),
    rescueInitialProvider: readOptionalString(record, ['rescueInitialProvider', 'rescue_initial_provider']),
    rescueInitialCredentialId: readOptionalString(record, ['rescueInitialCredentialId', 'rescue_initial_credential_id']),
    rescueInitialFailureCode: readOptionalString(record, ['rescueInitialFailureCode', 'rescue_initial_failure_code']),
    rescueInitialFailureStatus: readOptionalNumber(record, ['rescueInitialFailureStatus', 'rescue_initial_failure_status']),
    streaming: readOptionalBoolean(record, ['streaming'], false),
    upstreamStatus: readOptionalNumber(record, ['upstreamStatus', 'upstream_status']),
    latencyMs: readOptionalNumber(record, ['latencyMs', 'latency_ms']),
    ttfbMs: readOptionalNumber(record, ['ttfbMs', 'ttfb_ms']),
    inputTokens: readOptionalNumber(record, ['inputTokens', 'input_tokens'], 0) ?? 0,
    outputTokens: readOptionalNumber(record, ['outputTokens', 'output_tokens'], 0) ?? 0,
    usageUnits: readOptionalNumber(record, ['usageUnits', 'usage_units'], 0) ?? 0,
    prompt: readOptionalString(record, ['prompt', 'promptPreview', 'prompt_preview']),
    response: readOptionalString(record, ['response', 'responsePreview', 'response_preview'])
  }));
}

function normalizeEventRows(value: unknown) {
  return readObjectArray(value, 'events').map((record) => ({
    id: readRequiredString(record, ['id'], 'event.id'),
    type: readRequiredString(record, ['type', 'eventType', 'event_type'], 'event.type'),
    createdAt: readIsoDate(pick(record, ['createdAt', 'created_at']), 'event.createdAt'),
    provider: normalizeProvider(pick(record, ['provider']), 'event.provider'),
    credentialId: readOptionalString(record, ['credentialId', 'credential_id']),
    credentialLabel: readOptionalString(record, ['credentialLabel', 'credential_label', 'debugLabel', 'debug_label']),
    summary: readRequiredString(record, ['summary'], 'event.summary'),
    severity: normalizeEventSeverity(pick(record, ['severity'])),
    statusCode: readOptionalNumber(record, ['statusCode', 'status_code']),
    reason: readOptionalString(record, ['reason']),
    metadata: readJsonRecord(record, ['metadata'])
  }));
}

function mergeDashboardTokens(input: {
  usage: ReturnType<typeof normalizeTokenUsageRows>;
  health: ReturnType<typeof normalizeTokenHealthRows>;
  routing: ReturnType<typeof normalizeTokenRoutingRows>;
}): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  const totalUsageUnits = input.usage.reduce((sum, row) => sum + row.usageUnits, 0);

  const createBaseRow = (seed: {
    credentialId: string;
    displayKey: string | null;
    debugLabel: string | null;
    provider: string;
    status: string;
    attempts: number;
    requests: number;
    usageUnits: number;
    percentOfWindow: number;
  }): Record<string, unknown> => ({
    credentialId: seed.credentialId,
    displayKey: seed.displayKey,
    debugLabel: seed.debugLabel,
    provider: seed.provider,
    status: seed.status,
    attempts: seed.attempts,
    requests: seed.requests,
    usageUnits: seed.usageUnits,
    percentOfWindow: seed.percentOfWindow,
    utilizationRate24h: null,
    maxedEvents7d: 0,
    monthlyContributionUsedUnits: 0,
    monthlyContributionLimitUnits: null,
    fiveHourReservePercent: null,
    fiveHourUtilizationRatio: null,
    fiveHourResetsAt: null,
    fiveHourContributionCapExhausted: null,
    sevenDayReservePercent: null,
    sevenDayUtilizationRatio: null,
    sevenDayResetsAt: null,
    sevenDayContributionCapExhausted: null,
    providerUsageFetchedAt: null,
    claudeFiveHourCapExhaustionCyclesObserved: null,
    claudeFiveHourUsageUnitsBeforeCapExhaustionLastWindow: null,
    claudeFiveHourAvgUsageUnitsBeforeCapExhaustion: null,
    claudeSevenDayCapExhaustionCyclesObserved: null,
    claudeSevenDayUsageUnitsBeforeCapExhaustionLastWindow: null,
    claudeSevenDayAvgUsageUnitsBeforeCapExhaustion: null,
    consecutiveFailures: null,
    consecutiveRateLimitCount: null,
    lastFailedStatus: null,
    authDiagnosis: null,
    accessTokenExpiresAt: null,
    refreshTokenState: null,
    rateLimitedUntil: null,
    nextProbeAt: null
  });

  for (const row of input.usage) {
    byId.set(row.credentialId, createBaseRow({
      credentialId: row.credentialId,
      displayKey: row.displayKey,
      debugLabel: row.debugLabel,
      provider: row.provider,
      status: row.status,
      attempts: row.attempts,
      requests: row.requests,
      usageUnits: row.usageUnits,
      percentOfWindow: totalUsageUnits > 0 ? Number((row.usageUnits / totalUsageUnits).toFixed(4)) : 0
    }));
  }

  for (const row of input.health) {
    const existing = byId.get(row.credentialId) ?? createBaseRow({
      credentialId: row.credentialId,
      displayKey: row.displayKey,
      debugLabel: row.debugLabel,
      provider: row.provider,
      status: row.status,
      attempts: 0,
      requests: 0,
      usageUnits: 0,
      percentOfWindow: 0
    });
    existing.displayKey = existing.displayKey ?? row.displayKey;
    existing.debugLabel = existing.debugLabel ?? row.debugLabel;
    existing.provider = existing.provider ?? row.provider;
    existing.status = row.status;
    existing.utilizationRate24h = row.utilizationRate24h;
    existing.maxedEvents7d = row.maxedEvents7d;
    existing.monthlyContributionUsedUnits = row.monthlyContributionUsedUnits;
    existing.monthlyContributionLimitUnits = row.monthlyContributionLimitUnits;
    existing.fiveHourReservePercent = row.fiveHourReservePercent;
    existing.fiveHourUtilizationRatio = row.fiveHourUtilizationRatio;
    existing.fiveHourResetsAt = row.fiveHourResetsAt;
    existing.fiveHourContributionCapExhausted = row.fiveHourContributionCapExhausted;
    existing.sevenDayReservePercent = row.sevenDayReservePercent;
    existing.sevenDayUtilizationRatio = row.sevenDayUtilizationRatio;
    existing.sevenDayResetsAt = row.sevenDayResetsAt;
    existing.sevenDayContributionCapExhausted = row.sevenDayContributionCapExhausted;
    existing.providerUsageFetchedAt = row.providerUsageFetchedAt;
    existing.claudeFiveHourCapExhaustionCyclesObserved = row.claudeFiveHourCapExhaustionCyclesObserved;
    existing.claudeFiveHourUsageUnitsBeforeCapExhaustionLastWindow =
      row.claudeFiveHourUsageUnitsBeforeCapExhaustionLastWindow;
    existing.claudeFiveHourAvgUsageUnitsBeforeCapExhaustion = row.claudeFiveHourAvgUsageUnitsBeforeCapExhaustion;
    existing.claudeSevenDayCapExhaustionCyclesObserved = row.claudeSevenDayCapExhaustionCyclesObserved;
    existing.claudeSevenDayUsageUnitsBeforeCapExhaustionLastWindow =
      row.claudeSevenDayUsageUnitsBeforeCapExhaustionLastWindow;
    existing.claudeSevenDayAvgUsageUnitsBeforeCapExhaustion = row.claudeSevenDayAvgUsageUnitsBeforeCapExhaustion;
    existing.consecutiveFailures = row.consecutiveFailures;
    existing.consecutiveRateLimitCount = row.consecutiveRateLimitCount;
    existing.lastFailedStatus = row.lastFailedStatus;
    existing.authDiagnosis = row.authDiagnosis;
    existing.accessTokenExpiresAt = row.accessTokenExpiresAt;
    existing.refreshTokenState = row.refreshTokenState;
    existing.rateLimitedUntil = row.rateLimitedUntil;
    existing.nextProbeAt = row.nextProbeAt;
    byId.set(row.credentialId, existing);
  }

  for (const row of input.routing) {
    const existing = byId.get(row.credentialId) ?? createBaseRow({
      credentialId: row.credentialId,
      displayKey: row.displayKey,
      debugLabel: row.debugLabel,
      provider: row.provider,
      status: 'active',
      attempts: 0,
      requests: 0,
      usageUnits: 0,
      percentOfWindow: 0
    });
    existing.displayKey = existing.displayKey ?? row.displayKey;
    existing.debugLabel = existing.debugLabel ?? row.debugLabel;
    existing.provider = existing.provider ?? row.provider;
    existing.attempts = Math.max(Number(existing.attempts ?? 0), row.totalAttempts);
    existing.errorRate = row.totalAttempts > 0 ? Number((row.errorCount / row.totalAttempts).toFixed(4)) : 0;
    existing.latencyP50Ms = row.latencyP50Ms;
    existing.authFailures24h = row.authFailures24h;
    existing.rateLimited24h = row.rateLimited24h;
    byId.set(row.credentialId, existing);
  }

  return Array.from(byId.values())
    .map((row) => {
      const derivedStatus = deriveDashboardTokenStatusRow({
        provider: String(row.provider ?? ''),
        rawStatus: String(row.status ?? 'active'),
        authDiagnosis: readTrimmedString(row.authDiagnosis) ?? null,
        accessTokenExpiresAt: readTrimmedString(row.accessTokenExpiresAt) ?? null,
        refreshTokenState: readTrimmedString(row.refreshTokenState) as 'missing' | 'present' | null,
        consecutiveFailures: readNumberLike(row.consecutiveFailures),
        consecutiveRateLimitCount: readNumberLike(row.consecutiveRateLimitCount),
        lastFailedStatus: readNumberLike(row.lastFailedStatus),
        rateLimitedUntil: readTrimmedString(row.rateLimitedUntil) ?? null,
        nextProbeAt: readTrimmedString(row.nextProbeAt) ?? null,
        fiveHourReservePercent: readNumberLike(row.fiveHourReservePercent),
        fiveHourUtilizationRatio: readNumberLike(row.fiveHourUtilizationRatio),
        fiveHourResetsAt: readTrimmedString(row.fiveHourResetsAt) ?? null,
        fiveHourContributionCapExhausted: readBooleanLike(row.fiveHourContributionCapExhausted),
        sevenDayReservePercent: readNumberLike(row.sevenDayReservePercent),
        sevenDayUtilizationRatio: readNumberLike(row.sevenDayUtilizationRatio),
        sevenDayResetsAt: readTrimmedString(row.sevenDayResetsAt) ?? null,
        sevenDayContributionCapExhausted: readBooleanLike(row.sevenDayContributionCapExhausted),
        providerUsageFetchedAt: readTrimmedString(row.providerUsageFetchedAt) ?? null
      });
      if (derivedStatus.hidden) return null;

      const {
        consecutiveFailures: _consecutiveFailures,
        consecutiveRateLimitCount: _consecutiveRateLimitCount,
        lastFailedStatus: _lastFailedStatus,
        authDiagnosis: _authDiagnosis,
        accessTokenExpiresAt: _accessTokenExpiresAt,
        refreshTokenState: _refreshTokenState,
        rateLimitedUntil: _rateLimitedUntil,
        nextProbeAt: _nextProbeAt,
        ...publicRow
      } = row;

      return {
        ...publicRow,
        rawStatus: derivedStatus.rawStatus,
        status: derivedStatus.compactStatus,
        compactStatus: derivedStatus.compactStatus,
        expandedStatus: derivedStatus.expandedStatus,
        statusSource: derivedStatus.statusSource,
        exclusionReason: derivedStatus.exclusionReason,
        ...(readTrimmedString(row.authDiagnosis) !== null
          ? { authDiagnosis: readTrimmedString(row.authDiagnosis) }
          : {}),
        ...(readTrimmedString(row.accessTokenExpiresAt) !== null
          ? { accessTokenExpiresAt: readTrimmedString(row.accessTokenExpiresAt) }
          : {}),
        ...(readTrimmedString(row.refreshTokenState) !== null
          ? { refreshTokenState: readTrimmedString(row.refreshTokenState) }
          : {})
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((left, right) => {
      const usageDelta = Number((right as { usageUnits?: unknown }).usageUnits ?? 0)
        - Number((left as { usageUnits?: unknown }).usageUnits ?? 0);
      if (usageDelta !== 0) return usageDelta;
      return String((left as { credentialId?: unknown }).credentialId).localeCompare(
        String((right as { credentialId?: unknown }).credentialId),
        'en'
      );
    }) as Array<Record<string, unknown>>;
}

function normalizeAnomalies(value: unknown) {
  const record = readObject(value, 'anomalies');
  const checksRecord = readObject(pick(record, ['checks']) ?? {}, 'checks');
  const checks = {
    missingDebugLabels: readOptionalNumber(checksRecord, ['missingDebugLabels', 'missing_debug_labels'], 0) ?? 0,
    unresolvedCredentialIdsInTokenModeUsage: readOptionalNumber(
      checksRecord,
      ['unresolvedCredentialIdsInTokenModeUsage', 'unresolved_credential_ids_in_token_mode_usage'],
      0
    ) ?? 0,
    nullCredentialIdsInRouting: readOptionalNumber(checksRecord, ['nullCredentialIdsInRouting', 'null_credential_ids_in_routing'], 0) ?? 0,
    staleAggregateWindows: readOptionalNumber(checksRecord, ['staleAggregateWindows', 'stale_aggregate_windows']),
    usageLedgerVsAggregateMismatchCount: readOptionalNumber(
      checksRecord,
      ['usageLedgerVsAggregateMismatchCount', 'usage_ledger_vs_aggregate_mismatch_count']
    )
  };

  const ok = readBooleanLike(pick(record, ['ok']));
  return {
    checks,
    ok: ok ?? Object.values(checks).every((count) => count === null || count === 0)
  };
}

function isFreshDashboardSnapshot(refreshedAt: Date, now = Date.now()): boolean {
  return now - refreshedAt.getTime() <= DASHBOARD_SNAPSHOT_FRESHNESS_MS;
}

async function buildDashboardSnapshotPayload(
  analytics: AnalyticsRouteRepository,
  query: DashboardFilters
): Promise<AnalyticsDashboardSnapshotPayload> {
  const snapshotAt = new Date().toISOString();
  const [summaryRaw, tokenUsageRaw, tokenHealthRaw, tokenRoutingRaw, buyersRaw, anomaliesRaw, eventsRaw] = await Promise.all([
    analytics.getSystemSummary(query),
    analytics.getTokenUsage(query),
    analytics.getTokenHealth(query),
    analytics.getTokenRouting(query),
    analytics.getBuyers(query),
    analytics.getAnomalies(query),
    analytics.getEvents({
      window: query.window,
      provider: query.provider,
      limit: 20
    })
  ]);

  const summary = normalizeSystemSummary(summaryRaw);
  const tokenUsage = normalizeTokenUsageRows(tokenUsageRaw);
  const tokenHealth = normalizeTokenHealthRows(tokenHealthRaw);
  const tokenRouting = normalizeTokenRoutingRows(tokenRoutingRaw);
  const buyers = normalizeBuyerRows(buyersRaw);
  const anomalies = normalizeAnomalies(anomaliesRaw);
  const events = normalizeEventRows(eventsRaw);
  const warnings = buildProviderUsageWarnings(tokenHealthRaw);
  const tokens = mergeDashboardTokens({
    usage: tokenUsage,
    health: tokenHealth,
    routing: tokenRouting
  });

  return {
    window: query.window,
    snapshotAt,
    summary: deriveDashboardSummaryFromTokens(
      summary,
      tokens,
      tokenUsage.length > 0 || tokenHealth.length > 0 || tokenRouting.length > 0
    ),
    tokens,
    buyers,
    anomalies,
    events,
    warnings
  };
}

export function createAnalyticsRouter(deps: AnalyticsRouteDeps): Router {
  const router = Router();
  const analytics = deps.analytics ?? missingAnalyticsRepository;
  const dashboardSnapshots = deps.dashboardSnapshots;

  router.get('/v1/admin/analytics/tokens', requireApiKey(deps.apiKeys, ['admin']), async (req, res, next) => {
    try {
      const query = tokenUsageQuerySchema.parse(req.query);
      const rows = await analytics.getTokenUsage(query);
      res.json({
        window: query.window,
        tokens: normalizeTokenUsageRows(rows)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/v1/admin/analytics/tokens/health', requireApiKey(deps.apiKeys, ['admin']), async (req, res, next) => {
    try {
      const query = tokenHealthQuerySchema.parse(req.query);
      const rows = await analytics.getTokenHealth(query);
      res.json({
        window: query.window,
        tokens: normalizeTokenHealthRows(rows)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/v1/admin/analytics/tokens/routing', requireApiKey(deps.apiKeys, ['admin']), async (req, res, next) => {
    try {
      const query = tokenRoutingQuerySchema.parse(req.query);
      const rows = await analytics.getTokenRouting(query);
      res.json({
        window: query.window,
        tokens: normalizeTokenRoutingRows(rows)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/v1/admin/analytics/system', requireApiKey(deps.apiKeys, ['admin']), async (req, res, next) => {
    try {
      const query = systemSummaryQuerySchema.parse(req.query);
      const summary = await analytics.getSystemSummary(query);
      res.json({
        window: query.window,
        ...normalizeSystemSummary(summary)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/v1/admin/analytics/buyers', requireApiKey(deps.apiKeys, ['admin']), async (req, res, next) => {
    try {
      const query = buyerQuerySchema.parse(req.query);
      const buyers = await analytics.getBuyers(query);
      res.json({
        window: query.window,
        buyers: normalizeBuyerRows(buyers)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/v1/admin/analytics/timeseries', requireApiKey(deps.apiKeys, ['admin']), async (req, res, next) => {
    try {
      const query = timeSeriesQuerySchema.parse(req.query);
      const series = await analytics.getTimeSeries(query);
      res.json({
        window: query.window,
        granularity: query.granularity,
        series: normalizeTimeSeries(series)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/v1/admin/analytics/buyers/timeseries', requireApiKey(deps.apiKeys, ['admin']), async (req, res, next) => {
    try {
      const query = buyerTimeSeriesQuerySchema.parse(req.query);
      const series = await analytics.getBuyerTimeSeries(query);
      res.json({
        window: query.window,
        granularity: query.granularity,
        series: normalizeBuyerTimeSeries(series)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/v1/admin/analytics/requests', requireApiKey(deps.apiKeys, ['admin']), async (req, res, next) => {
    try {
      const query = recentRequestsQuerySchema.parse(req.query);
      const requests = await analytics.getRecentRequests(query);
      res.json({
        window: query.window,
        limit: query.limit,
        requests: normalizeRecentRequests(requests)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/v1/admin/analytics/events', requireApiKey(deps.apiKeys, ['admin']), async (req, res, next) => {
    try {
      const query = eventsQuerySchema.parse(req.query);
      const events = await analytics.getEvents(query);
      res.json({
        window: query.window,
        limit: query.limit,
        events: normalizeEventRows(events)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/v1/admin/analytics/anomalies', requireApiKey(deps.apiKeys, ['admin']), async (req, res, next) => {
    try {
      const query = anomaliesQuerySchema.parse(req.query);
      const anomalies = await analytics.getAnomalies(query);
      res.json({
        window: query.window,
        ...normalizeAnomalies(anomalies)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/v1/admin/analytics/dashboard', requireApiKey(deps.apiKeys, ['admin']), async (req, res, next) => {
    try {
      const query = dashboardQuerySchema.parse(req.query);
      if (dashboardSnapshots) {
        const cached = await dashboardSnapshots.get(query);
        if (cached && isFreshDashboardSnapshot(cached.refreshedAt)) {
          res.json({
            ...cached.payload,
            warnings: normalizeWarnings((cached.payload as Record<string, unknown>).warnings)
          });
          return;
        }

        const refreshed = await dashboardSnapshots.refreshIfLockAvailable(
          query,
          () => buildDashboardSnapshotPayload(analytics, query)
        );

        if (refreshed) {
          res.json({
            ...refreshed.payload,
            warnings: normalizeWarnings((refreshed.payload as Record<string, unknown>).warnings)
          });
          return;
        }

        if (cached) {
          res.json({
            ...cached.payload,
            warnings: normalizeWarnings((cached.payload as Record<string, unknown>).warnings)
          });
          return;
        }
      }

      const payload = await buildDashboardSnapshotPayload(analytics, query);
      res.json({
        ...payload,
        warnings: normalizeWarnings((payload as Record<string, unknown>).warnings)
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

type RuntimeReposWithAnalytics = typeof runtime.repos & {
  analytics?: AnalyticsRouteRepository;
  analyticsDashboardSnapshots?: DashboardSnapshotStore;
};

export default createAnalyticsRouter({
  apiKeys: runtime.repos.apiKeys,
  analytics: (runtime.repos as RuntimeReposWithAnalytics).analytics,
  dashboardSnapshots: (runtime.repos as RuntimeReposWithAnalytics).analyticsDashboardSnapshots
});
