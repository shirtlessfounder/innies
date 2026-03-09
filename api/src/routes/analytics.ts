import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import type { ApiKeyRepository } from '../repos/apiKeyRepository.js';
import { runtime } from '../services/runtime.js';
import type { AnalyticsWindow } from '../utils/analytics.js';
import { AppError } from '../utils/errors.js';

const ANALYTICS_SOURCES = ['openclaw', 'cli-claude', 'cli-codex', 'direct'] as const;
const TOKEN_PROVIDERS = ['anthropic', 'openai'] as const;
const TOKEN_STATUSES = ['active', 'rotating', 'maxed', 'expired', 'revoked'] as const;

type AnalyticsSource = typeof ANALYTICS_SOURCES[number];
type AnalyticsProvider = typeof TOKEN_PROVIDERS[number];
type AnalyticsGranularity = 'hour' | 'day';
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

export interface AnalyticsRouteRepository {
  getTokenUsage(filters: TokenUsageFilters): Promise<unknown>;
  getTokenHealth(filters: TokenHealthFilters): Promise<unknown>;
  getTokenRouting(filters: TokenRoutingFilters): Promise<unknown>;
  getSystemSummary(filters: SystemSummaryFilters): Promise<unknown>;
  getTimeSeries(filters: TimeSeriesFilters): Promise<unknown>;
  getRecentRequests(filters: RecentRequestsFilters): Promise<unknown>;
  getAnomalies(filters: AnomaliesFilters): Promise<unknown>;
}

type AnalyticsRouteDeps = {
  apiKeys: ApiKeyRepository;
  analytics?: AnalyticsRouteRepository;
};

const analyticsWindowSchema = z.string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['24h', '7d', '1m', 'all', '30d']))
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
  .pipe(z.enum(['hour', 'day']));

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

function defaultGranularity(window: AnalyticsWindow): AnalyticsGranularity {
  return window === '24h' ? 'hour' : 'day';
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
  getRecentRequests: failMissingRepository as AnalyticsRouteRepository['getRecentRequests'],
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

function normalizeTokenStatus(value: unknown, field: string): typeof TOKEN_STATUSES[number] {
  const normalized = readTrimmedString(value)?.toLowerCase();
  if (normalized && (TOKEN_STATUSES as readonly string[]).includes(normalized)) {
    return normalized as typeof TOKEN_STATUSES[number];
  }
  throw new AppError('internal_error', 500, `Analytics repository returned invalid ${field}`);
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
    debugLabel: readOptionalString(record, ['debugLabel', 'debug_label']),
    provider: normalizeProvider(pick(record, ['provider']), 'provider'),
    status: normalizeTokenStatus(pick(record, ['status']), 'status'),
    requests: readRequiredNumber(record, ['requests', 'request_count'], 'requests'),
    usageUnits: readRequiredNumber(record, ['usageUnits', 'usage_units'], 'usageUnits'),
    retailEquivalentMinor: readOptionalNumber(record, ['retailEquivalentMinor', 'retail_equivalent_minor'], 0) ?? 0,
    inputTokens: readOptionalNumber(record, ['inputTokens', 'input_tokens'], 0) ?? 0,
    outputTokens: readOptionalNumber(record, ['outputTokens', 'output_tokens'], 0) ?? 0,
    bySource: normalizeSourceBreakdown(pick(record, ['bySource', 'by_source']))
  }));
}

function normalizeTokenHealthRows(value: unknown) {
  return readObjectArray(value, 'tokens').map((record) => ({
    credentialId: readRequiredString(record, ['credentialId', 'credential_id'], 'credentialId'),
    debugLabel: readOptionalString(record, ['debugLabel', 'debug_label']),
    provider: normalizeProvider(pick(record, ['provider']), 'provider'),
    status: normalizeTokenStatus(pick(record, ['status']), 'status'),
    consecutiveFailures: readOptionalNumber(record, ['consecutiveFailures', 'consecutive_failure_count'], 0) ?? 0,
    lastFailedStatus: readOptionalNumber(record, ['lastFailedStatus', 'last_failed_status']),
    lastFailedAt: readOptionalIsoDate(record, ['lastFailedAt', 'last_failed_at']),
    maxedAt: readOptionalIsoDate(record, ['maxedAt', 'maxed_at']),
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
    createdAt: readOptionalIsoDate(record, ['createdAt', 'created_at']),
    expiresAt: readOptionalIsoDate(record, ['expiresAt', 'expires_at'])
  }));
}

function normalizeTokenRoutingRows(value: unknown) {
  return readObjectArray(value, 'tokens').map((record) => ({
    credentialId: readRequiredString(record, ['credentialId', 'credential_id'], 'credentialId'),
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

function normalizeRecentRequests(value: unknown) {
  return readObjectArray(value, 'requests').map((record) => ({
    requestId: readRequiredString(record, ['requestId', 'request_id'], 'requestId'),
    createdAt: readIsoDate(pick(record, ['createdAt', 'created_at']), 'createdAt'),
    credentialId: readOptionalString(record, ['credentialId', 'credential_id']),
    credentialLabel: readOptionalString(record, ['credentialLabel', 'credential_label', 'debugLabel', 'debug_label']),
    provider: normalizeProvider(pick(record, ['provider']), 'provider'),
    model: readRequiredString(record, ['model'], 'model'),
    source: normalizeSourceValue(pick(record, ['source'])) ?? 'direct',
    translated: readOptionalBoolean(record, ['translated'], false),
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

export function createAnalyticsRouter(deps: AnalyticsRouteDeps): Router {
  const router = Router();
  const analytics = deps.analytics ?? missingAnalyticsRepository;

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

  return router;
}

type RuntimeReposWithAnalytics = typeof runtime.repos & { analytics?: AnalyticsRouteRepository };

export default createAnalyticsRouter({
  apiKeys: runtime.repos.apiKeys,
  analytics: (runtime.repos as RuntimeReposWithAnalytics).analytics
});
