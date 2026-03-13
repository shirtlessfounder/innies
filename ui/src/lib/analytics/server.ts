import 'server-only';

import { extractAnalyticsErrorMessage, safeParseAnalyticsBody } from './errorSummary';
import {
  type AnalyticsAnomalies,
  type AnalyticsApiWindow,
  type AnalyticsBuyerRow,
  type AnalyticsCapabilities,
  type AnalyticsDashboardSnapshot,
  type AnalyticsEventRow,
  type AnalyticsMetric,
  type AnalyticsPageWindow,
  type AnalyticsSeriesPoint,
  type AnalyticsSeriesResponse,
  type AnalyticsSummary,
  type AnalyticsTokenRow,
} from './types';

const DEFAULT_TIMEOUT_MS = 15000;

const PAGE_TO_API_WINDOW: Record<AnalyticsPageWindow, AnalyticsApiWindow> = {
  '5h': '5h',
  '24h': '24h',
  '1w': '7d',
  '1m': '1m',
};

type AdminApiConfig = {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
};

type ProviderPreferenceResponse = {
  preferredProvider?: string | null;
  effectiveProvider?: string | null;
};

type CurrentSystemBuyer = {
  apiKeyId: string;
  orgId: string;
  requests?: number;
  usageUnits?: number;
  percentOfTotal?: number;
};

type CurrentSystemResponse = {
  totalRequests?: number;
  totalUsageUnits?: number;
  activeTokens?: number;
  maxedTokens?: number;
  errorRate?: number;
  fallbackRate?: number;
  latencyP50Ms?: number | null;
  ttfbP50Ms?: number | null;
  topBuyers?: CurrentSystemBuyer[];
};

type CurrentTokenUsageRow = {
  credentialId: string;
  debugLabel?: string | null;
  provider?: string;
  status?: string;
  requests?: number;
  usageUnits?: number;
};

type CurrentTokenHealthRow = {
  credentialId: string;
  debugLabel?: string | null;
  provider?: string;
  status?: string;
  consecutiveRateLimitCount?: number;
  lastRateLimitedAt?: string | null;
  rateLimitedUntil?: string | null;
  utilizationRate24h?: number | null;
  maxedEvents7d?: number;
  monthlyContributionUsedUnits?: number;
  monthlyContributionLimitUnits?: number | null;
  fiveHourReservePercent?: number | null;
  fiveHourUtilizationRatio?: number | null;
  fiveHourResetsAt?: string | null;
  fiveHourContributionCapExhausted?: boolean | null;
  sevenDayReservePercent?: number | null;
  sevenDayUtilizationRatio?: number | null;
  sevenDayResetsAt?: string | null;
  sevenDayContributionCapExhausted?: boolean | null;
  providerUsageFetchedAt?: string | null;
};

type CurrentTokenRoutingRow = {
  credentialId: string;
  debugLabel?: string | null;
  provider?: string;
  totalAttempts?: number;
  errorCount?: number;
  latencyP50Ms?: number | null;
  authFailures24h?: number;
  rateLimited24h?: number;
};

type CurrentTokensResponse<T> = {
  tokens?: T[];
};

type CurrentAnomaliesResponse = AnalyticsAnomalies;

type CurrentEventsResponse = {
  events?: Array<{
    id?: string;
    type?: string;
    createdAt?: string;
    provider?: string | null;
    credentialId?: string | null;
    credentialLabel?: string | null;
    summary?: string;
    severity?: string;
    statusCode?: number | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  }>;
};

type CurrentBuyersResponse = {
  buyers?: Array<{
    apiKeyId: string;
    displayKey?: string;
    label?: string | null;
    orgId: string;
    orgLabel?: string | null;
    orgName?: string | null;
    preferredProvider?: string | null;
    effectiveProvider?: string | null;
    requests?: number;
    usageUnits?: number;
    percentOfTotal?: number;
    percentOfWindow?: number;
    lastSeenAt?: string | null;
    latencyP50Ms?: number | null;
    errorRate?: number | null;
  }>;
};

type CurrentTokenSeriesResponse = {
  series?: Array<{
    date?: string;
    requests?: number;
    usageUnits?: number;
    errorRate?: number;
    latencyP50Ms?: number | null;
  }>;
};

type CurrentBuyerSeriesResponse = {
  series?: Array<{
    bucket?: string;
    date?: string;
    requests?: number;
    usageUnits?: number;
    errorRate?: number;
    latencyP50Ms?: number | null;
  }>;
};

type CurrentDashboardTokenRow = {
  credentialId: string;
  displayKey?: string;
  debugLabel?: string | null;
  provider?: string;
  status?: string;
  consecutiveRateLimitCount?: number;
  lastRateLimitedAt?: string | null;
  rateLimitedUntil?: string | null;
  attempts?: number;
  requests?: number;
  usageUnits?: number;
  percentOfWindow?: number;
  utilizationRate24h?: number | null;
  maxedEvents7d?: number;
  monthlyContributionUsedUnits?: number;
  monthlyContributionLimitUnits?: number | null;
  fiveHourReservePercent?: number | null;
  fiveHourUtilizationRatio?: number | null;
  fiveHourResetsAt?: string | null;
  fiveHourContributionCapExhausted?: boolean | null;
  sevenDayReservePercent?: number | null;
  sevenDayUtilizationRatio?: number | null;
  sevenDayResetsAt?: string | null;
  sevenDayContributionCapExhausted?: boolean | null;
  providerUsageFetchedAt?: string | null;
  latencyP50Ms?: number | null;
  errorRate?: number | null;
  authFailures24h?: number;
  rateLimited24h?: number;
};

type CurrentDashboardBuyerRow = {
  apiKeyId: string;
  displayKey?: string;
  label?: string | null;
  orgId?: string | null;
  orgLabel?: string | null;
  orgName?: string | null;
  preferredProvider?: string | null;
  effectiveProvider?: string | null;
  requests?: number;
  usageUnits?: number;
  percentOfWindow?: number;
  percentOfTotal?: number;
  lastSeenAt?: string | null;
  latencyP50Ms?: number | null;
  errorRate?: number | null;
};

type CurrentDashboardResponse = {
  snapshotAt?: string;
  summary?: CurrentSystemResponse;
  tokens?: CurrentDashboardTokenRow[];
  buyers?: CurrentDashboardBuyerRow[];
  anomalies?: CurrentAnomaliesResponse;
  events?: CurrentEventsResponse['events'];
  warnings?: string[];
};

export class AnalyticsServerError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'AnalyticsServerError';
    this.status = status;
    this.details = details ?? null;
  }
}

function readAdminApiConfig(): AdminApiConfig {
  const baseUrl = process.env.INNIES_ADMIN_API_BASE_URL?.trim()
    || process.env.INNIES_BASE_URL?.trim();
  const apiKey = process.env.INNIES_ADMIN_API_KEY?.trim();
  const timeoutMs = Number(process.env.INNIES_ADMIN_API_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  if (!baseUrl) {
    throw new AnalyticsServerError(503, 'Missing INNIES_ADMIN_API_BASE_URL or INNIES_BASE_URL');
  }

  if (!apiKey) {
    throw new AnalyticsServerError(503, 'Missing INNIES_ADMIN_API_KEY');
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULT_TIMEOUT_MS,
  };
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = toNumber(value, Number.NaN);
  return Number.isFinite(numeric) ? numeric : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function toNullableBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

function normalizeDashboardWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => toStringOrNull(entry))
    .filter((entry): entry is string => entry !== null);
}

function deriveContributionCapUsedRatio(input: {
  provider: string | null;
  utilizationRatio: number | null;
}): number | null {
  if ((input.provider ?? '').trim().toLowerCase() !== 'anthropic') return null;
  if (input.utilizationRatio === null) return null;
  return Math.min(1, Math.max(0, input.utilizationRatio));
}

function deriveFallbackTokenStatus(input: {
  provider: string | null;
  status: string | null;
  rateLimitedUntil: string | null;
  fiveHourContributionCapExhausted?: boolean | null;
  sevenDayContributionCapExhausted?: boolean | null;
}): string {
  const normalized = input.status ?? 'unknown';
  if (
    normalized === 'active'
    && (input.fiveHourContributionCapExhausted === true || input.sevenDayContributionCapExhausted === true)
  ) {
    return 'maxed';
  }
  if ((input.provider ?? '').trim().toLowerCase() === 'anthropic' && normalized === 'maxed') {
    return 'rate_limited';
  }
  if (normalized === 'active' && input.rateLimitedUntil) {
    const expiresAt = Date.parse(input.rateLimitedUntil);
    if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
      return 'rate_limited';
    }
  }
  return normalized;
}

function mapSeverity(value: unknown): AnalyticsEventRow['severity'] {
  const normalized = toStringOrNull(value)?.toLowerCase();
  if (normalized === 'error') return 'error';
  if (normalized === 'warn' || normalized === 'warning') return 'warn';
  return 'info';
}

export function normalizePageWindow(value: string | null | undefined): AnalyticsPageWindow {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === '5h' || normalized === '24h' || normalized === '1w' || normalized === '1m') {
    return normalized;
  }
  return '24h';
}

export function pageWindowToApiWindow(window: AnalyticsPageWindow): AnalyticsApiWindow {
  return PAGE_TO_API_WINDOW[window];
}

export function formatDisplayKey(prefix: 'cred' | 'key', id: string): string {
  const compact = id.replace(/-/g, '');
  if (compact.length < 8) return `${prefix}_${id}`;
  return `${prefix}_${compact.slice(0, 4)}…${compact.slice(-4)}`;
}

async function fetchAdminJson<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
  const config = readAdminApiConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const url = new URL(path, `${config.baseUrl}/`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value) url.searchParams.set(key, value);
  }

  try {
    const response = await fetch(url, {
      headers: {
        'x-api-key': config.apiKey,
        accept: 'application/json',
      },
      cache: 'no-store',
      signal: controller.signal,
    });

    const text = await response.text();
    const body = text.length > 0 ? safeParseAnalyticsBody(text) : null;

    if (!response.ok) {
      const message = extractAnalyticsErrorMessage(body) ?? `Innies admin API request failed (${response.status})`;
      throw new AnalyticsServerError(response.status, message, body);
    }

    return body as T;
  } catch (error) {
    if (error instanceof AnalyticsServerError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AnalyticsServerError(504, `Timed out fetching ${path}`);
    }
    throw new AnalyticsServerError(502, error instanceof Error ? error.message : `Failed to fetch ${path}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOptionalAdminJson<T>(
  path: string,
  query?: Record<string, string | undefined>,
): Promise<T | null> {
  try {
    return await fetchAdminJson<T>(path, query);
  } catch (error) {
    if (error instanceof AnalyticsServerError && (error.status === 404 || error.status === 501)) {
      return null;
    }
    throw error;
  }
}

function synthesizeAnomalyEvents(snapshotAt: string, anomalies: AnalyticsAnomalies): AnalyticsEventRow[] {
  const checks = anomalies.checks;
  const entries: Array<[string, number | null, string]> = [
    ['missing_debug_labels', checks.missingDebugLabels, 'Missing token debug labels detected'],
    ['unresolved_credential_ids', checks.unresolvedCredentialIdsInTokenModeUsage, 'Unresolved credential ids present in token-mode usage'],
    ['null_credential_ids', checks.nullCredentialIdsInRouting, 'Null credential ids present in routing events'],
    ['stale_aggregate_windows', checks.staleAggregateWindows, 'Daily aggregate windows are stale'],
    ['aggregate_mismatches', checks.usageLedgerVsAggregateMismatchCount, 'Daily aggregates do not match usage ledger'],
  ];

  return entries
    .filter(([, count]) => count !== null && Number(count) > 0)
    .map(([key, count, summary]) => ({
      id: `anomaly-${key}`,
      type: 'anomaly',
      createdAt: snapshotAt,
      provider: null,
      credentialId: null,
      credentialLabel: null,
      summary: `${summary}: ${count}`,
      severity: key === 'aggregate_mismatches' ? 'error' : 'warn',
      statusCode: null,
      reason: null,
      metadata: { check: key, count },
    }));
}

async function fetchBuyerPreference(apiKeyId: string): Promise<ProviderPreferenceResponse | null> {
  return fetchOptionalAdminJson<ProviderPreferenceResponse>(`/v1/admin/buyer-keys/${apiKeyId}/provider-preference`);
}

function normalizeSummary(raw: CurrentSystemResponse): AnalyticsSummary {
  return {
    totalRequests: toNumber(raw.totalRequests),
    totalUsageUnits: toNumber(raw.totalUsageUnits),
    activeTokens: toNumber(raw.activeTokens),
    maxedTokens: toNumber(raw.maxedTokens),
    errorRate: toNumber(raw.errorRate),
    fallbackRate: toNumber(raw.fallbackRate),
    latencyP50Ms: toNullableNumber(raw.latencyP50Ms),
    ttfbP50Ms: toNullableNumber(raw.ttfbP50Ms),
  };
}

function normalizeEventRows(raw: CurrentEventsResponse | null): AnalyticsEventRow[] {
  if (!raw?.events) return [];
  return raw.events.map((event, index) => ({
    id: toStringOrNull(event.id) ?? `event-${index}`,
    type: toStringOrNull(event.type) ?? 'event',
    createdAt: toStringOrNull(event.createdAt) ?? new Date().toISOString(),
    provider: toStringOrNull(event.provider),
    credentialId: toStringOrNull(event.credentialId),
    credentialLabel: toStringOrNull(event.credentialLabel),
    summary: toStringOrNull(event.summary) ?? 'Analytics event',
    severity: mapSeverity(event.severity),
    statusCode: typeof event.statusCode === 'number' ? event.statusCode : null,
    reason: toStringOrNull(event.reason),
    metadata: event.metadata ?? {},
  }));
}

async function normalizeBuyerRows(
  summary: AnalyticsSummary,
  buyersPayload: CurrentBuyersResponse | null,
  fallbackBuyers: CurrentSystemBuyer[] | undefined,
): Promise<{ rows: AnalyticsBuyerRow[]; complete: boolean }> {
  if (buyersPayload?.buyers) {
    const rows = buyersPayload.buyers.map((buyer) => ({
      apiKeyId: buyer.apiKeyId,
      displayKey: buyer.displayKey ?? formatDisplayKey('key', buyer.apiKeyId),
      label: toStringOrNull(buyer.label),
      orgId: buyer.orgId,
      orgLabel: toStringOrNull(buyer.orgLabel ?? buyer.orgName),
      preferredProvider: toStringOrNull(buyer.preferredProvider),
      effectiveProvider: toStringOrNull(buyer.effectiveProvider),
      requests: toNumber(buyer.requests),
      usageUnits: toNumber(buyer.usageUnits),
      percentOfWindow: toNumber(
        buyer.percentOfWindow,
        summary.totalUsageUnits > 0 ? toNumber(buyer.usageUnits) / summary.totalUsageUnits : 0,
      ),
      lastSeenAt: toStringOrNull(buyer.lastSeenAt),
      latencyP50Ms: toNullableNumber(buyer.latencyP50Ms),
      errorRate: toNullableNumber(buyer.errorRate),
      deltaRequests: 0,
      deltaUsageUnits: 0,
      flashToken: null,
      isPartialData: false,
    }));
    return { rows, complete: true };
  }

  const rows = await Promise.all(
    (fallbackBuyers ?? []).map(async (buyer) => {
      const preference = await fetchBuyerPreference(buyer.apiKeyId);
      return {
        apiKeyId: buyer.apiKeyId,
        displayKey: formatDisplayKey('key', buyer.apiKeyId),
        label: null,
        orgId: buyer.orgId,
        orgLabel: null,
        preferredProvider: toStringOrNull(preference?.preferredProvider),
        effectiveProvider: toStringOrNull(preference?.effectiveProvider),
        requests: toNumber(buyer.requests),
        usageUnits: toNumber(buyer.usageUnits),
        percentOfWindow: toNumber(
          buyer.percentOfTotal,
          summary.totalUsageUnits > 0 ? toNumber(buyer.usageUnits) / summary.totalUsageUnits : 0,
        ),
        lastSeenAt: null,
        latencyP50Ms: null,
        errorRate: null,
        deltaRequests: 0,
        deltaUsageUnits: 0,
        flashToken: null,
        isPartialData: true,
      } satisfies AnalyticsBuyerRow;
    }),
  );

  rows.sort((left, right) => right.usageUnits - left.usageUnits || right.requests - left.requests);
  return { rows, complete: false };
}

function normalizeDashboardTokenRows(
  summary: AnalyticsSummary,
  rows: CurrentDashboardTokenRow[] | undefined,
): AnalyticsTokenRow[] {
  return (rows ?? [])
    .map((row) => {
      const usageUnits = toNumber(row.usageUnits);
      const provider = toStringOrNull(row.provider) ?? 'unknown';
      const fiveHourReservePercent = toNullableNumber(row.fiveHourReservePercent);
      const fiveHourUtilizationRatio = toNullableNumber(row.fiveHourUtilizationRatio);
      const fiveHourContributionCapExhausted = toNullableBoolean(row.fiveHourContributionCapExhausted);
      const sevenDayReservePercent = toNullableNumber(row.sevenDayReservePercent);
      const sevenDayUtilizationRatio = toNullableNumber(row.sevenDayUtilizationRatio);
      const sevenDayContributionCapExhausted = toNullableBoolean(row.sevenDayContributionCapExhausted);
      return {
        credentialId: row.credentialId,
        displayKey: row.displayKey ?? formatDisplayKey('cred', row.credentialId),
        debugLabel: toStringOrNull(row.debugLabel),
        provider,
        status: toStringOrNull(row.status) ?? 'unknown',
        attempts: toNumber(row.attempts, toNumber(row.requests)),
        requests: toNumber(row.requests),
        usageUnits,
        percentOfWindow: toNumber(
          row.percentOfWindow,
          summary.totalUsageUnits > 0 ? usageUnits / summary.totalUsageUnits : 0,
        ),
        utilizationRate24h: toNullableNumber(row.utilizationRate24h),
        maxedEvents7d: toNumber(row.maxedEvents7d),
        monthlyContributionUsedUnits: toNumber(row.monthlyContributionUsedUnits),
        monthlyContributionLimitUnits: toNullableNumber(row.monthlyContributionLimitUnits),
        fiveHourReservePercent,
        fiveHourUtilizationRatio,
        fiveHourResetsAt: toStringOrNull(row.fiveHourResetsAt),
        fiveHourContributionCapExhausted,
        sevenDayReservePercent,
        sevenDayUtilizationRatio,
        sevenDayResetsAt: toStringOrNull(row.sevenDayResetsAt),
        sevenDayContributionCapExhausted,
        providerUsageFetchedAt: toStringOrNull(row.providerUsageFetchedAt),
        fiveHourCapUsedRatio: deriveContributionCapUsedRatio({
          provider,
          utilizationRatio: fiveHourUtilizationRatio,
        }),
        sevenDayCapUsedRatio: deriveContributionCapUsedRatio({
          provider,
          utilizationRatio: sevenDayUtilizationRatio,
        }),
        latencyP50Ms: toNullableNumber(row.latencyP50Ms),
        errorRate: toNullableNumber(row.errorRate),
        authFailures24h: toNumber(row.authFailures24h),
        rateLimited24h: toNumber(row.rateLimited24h),
        deltaAttempts: 0,
        deltaUsageUnits: 0,
        flashToken: null,
      } satisfies AnalyticsTokenRow;
    })
    .sort((left, right) => right.usageUnits - left.usageUnits || right.attempts - left.attempts);
}

function normalizeDashboardBuyerRows(
  summary: AnalyticsSummary,
  rows: CurrentDashboardBuyerRow[] | undefined,
): AnalyticsBuyerRow[] {
  return (rows ?? [])
    .map((buyer) => {
      const usageUnits = toNumber(buyer.usageUnits);
      return {
        apiKeyId: buyer.apiKeyId,
        displayKey: buyer.displayKey ?? formatDisplayKey('key', buyer.apiKeyId),
        label: toStringOrNull(buyer.label),
        orgId: toStringOrNull(buyer.orgId) ?? '--',
        orgLabel: toStringOrNull(buyer.orgLabel ?? buyer.orgName),
        preferredProvider: toStringOrNull(buyer.preferredProvider),
        effectiveProvider: toStringOrNull(buyer.effectiveProvider),
        requests: toNumber(buyer.requests),
        usageUnits,
        percentOfWindow: toNumber(
          buyer.percentOfWindow ?? buyer.percentOfTotal,
          summary.totalUsageUnits > 0 ? usageUnits / summary.totalUsageUnits : 0,
        ),
        lastSeenAt: toStringOrNull(buyer.lastSeenAt),
        latencyP50Ms: toNullableNumber(buyer.latencyP50Ms),
        errorRate: toNullableNumber(buyer.errorRate),
        deltaRequests: 0,
        deltaUsageUnits: 0,
        flashToken: null,
        isPartialData: false,
      } satisfies AnalyticsBuyerRow;
    })
    .sort((left, right) => right.usageUnits - left.usageUnits || right.requests - left.requests);
}

function buildTokenRows(
  summary: AnalyticsSummary,
  usagePayload: CurrentTokensResponse<CurrentTokenUsageRow>,
  healthPayload: CurrentTokensResponse<CurrentTokenHealthRow>,
  routingPayload: CurrentTokensResponse<CurrentTokenRoutingRow>,
): AnalyticsTokenRow[] {
  const usageMap = new Map((usagePayload.tokens ?? []).map((row) => [row.credentialId, row]));
  const healthMap = new Map((healthPayload.tokens ?? []).map((row) => [row.credentialId, row]));
  const routingMap = new Map((routingPayload.tokens ?? []).map((row) => [row.credentialId, row]));
  const ids = new Set([...usageMap.keys(), ...healthMap.keys(), ...routingMap.keys()]);

  const rows = [...ids].map((credentialId) => {
    const usage = usageMap.get(credentialId);
    const health = healthMap.get(credentialId);
    const routing = routingMap.get(credentialId);
    const usageUnits = toNumber(usage?.usageUnits);
    const attempts = toNumber(routing?.totalAttempts, toNumber(usage?.requests));
    const requests = toNumber(usage?.requests);
    const errorCount = toNumber(routing?.errorCount);
    const errorRate = attempts > 0 ? errorCount / attempts : null;
    const rawStatus = toStringOrNull(health?.status ?? usage?.status);
    const rateLimitedUntil = toStringOrNull(health?.rateLimitedUntil);
    const provider = toStringOrNull(health?.provider ?? usage?.provider ?? routing?.provider) ?? 'unknown';
    const fiveHourReservePercent = toNullableNumber(health?.fiveHourReservePercent);
    const fiveHourUtilizationRatio = toNullableNumber(health?.fiveHourUtilizationRatio);
    const fiveHourContributionCapExhausted = toNullableBoolean(health?.fiveHourContributionCapExhausted);
    const sevenDayReservePercent = toNullableNumber(health?.sevenDayReservePercent);
    const sevenDayUtilizationRatio = toNullableNumber(health?.sevenDayUtilizationRatio);
    const sevenDayContributionCapExhausted = toNullableBoolean(health?.sevenDayContributionCapExhausted);

    return {
      credentialId,
      displayKey: formatDisplayKey('cred', credentialId),
      debugLabel: toStringOrNull(health?.debugLabel ?? usage?.debugLabel ?? routing?.debugLabel),
      provider,
      status: deriveFallbackTokenStatus({
        provider,
        status: rawStatus,
        rateLimitedUntil,
        fiveHourContributionCapExhausted,
        sevenDayContributionCapExhausted,
      }),
      attempts,
      requests,
      usageUnits,
      percentOfWindow: summary.totalUsageUnits > 0 ? usageUnits / summary.totalUsageUnits : 0,
      utilizationRate24h: toNullableNumber(health?.utilizationRate24h),
      maxedEvents7d: toNumber(health?.maxedEvents7d),
      monthlyContributionUsedUnits: toNumber(health?.monthlyContributionUsedUnits),
      monthlyContributionLimitUnits: toNullableNumber(health?.monthlyContributionLimitUnits),
      fiveHourReservePercent,
      fiveHourUtilizationRatio,
      fiveHourResetsAt: toStringOrNull(health?.fiveHourResetsAt),
      fiveHourContributionCapExhausted,
      sevenDayReservePercent,
      sevenDayUtilizationRatio,
      sevenDayResetsAt: toStringOrNull(health?.sevenDayResetsAt),
      sevenDayContributionCapExhausted,
      providerUsageFetchedAt: toStringOrNull(health?.providerUsageFetchedAt),
      fiveHourCapUsedRatio: deriveContributionCapUsedRatio({
        provider,
        utilizationRatio: fiveHourUtilizationRatio,
      }),
      sevenDayCapUsedRatio: deriveContributionCapUsedRatio({
        provider,
        utilizationRatio: sevenDayUtilizationRatio,
      }),
      latencyP50Ms: toNullableNumber(routing?.latencyP50Ms),
      errorRate: toNullableNumber(errorRate),
      authFailures24h: toNumber(routing?.authFailures24h),
      rateLimited24h: toNumber(routing?.rateLimited24h),
      deltaAttempts: 0,
      deltaUsageUnits: 0,
      flashToken: null,
    } satisfies AnalyticsTokenRow;
  });

  rows.sort((left, right) => right.usageUnits - left.usageUnits || right.attempts - left.attempts);
  return rows;
}

function baseCapabilities(input: {
  supports5hWindow: boolean;
  buyersComplete: boolean;
  buyerSeriesAvailable: boolean;
  lifecycleEventsAvailable: boolean;
}): AnalyticsCapabilities {
  return {
    supports5hWindow: input.supports5hWindow,
    buyersComplete: input.buyersComplete,
    buyerSeriesAvailable: input.buyerSeriesAvailable,
    lifecycleEventsAvailable: input.lifecycleEventsAvailable,
    dashboardSnapshotAvailable: true,
    timeseriesMultiEntityAvailable: false,
  };
}

export async function getAnalyticsDashboardSnapshot(window: AnalyticsPageWindow): Promise<AnalyticsDashboardSnapshot> {
  const effectiveWindow = pageWindowToApiWindow(window);
  const dashboardPayload = await fetchOptionalAdminJson<CurrentDashboardResponse>('/v1/admin/analytics/dashboard', {
    window: effectiveWindow,
  });

  if (dashboardPayload) {
    const summary = normalizeSummary(dashboardPayload.summary ?? {});
    const snapshotAt = toStringOrNull(dashboardPayload.snapshotAt) ?? new Date().toISOString();
    const anomalies = dashboardPayload.anomalies ?? {
      ok: true,
      checks: {
        missingDebugLabels: 0,
        unresolvedCredentialIdsInTokenModeUsage: 0,
        nullCredentialIdsInRouting: 0,
        staleAggregateWindows: null,
        usageLedgerVsAggregateMismatchCount: null,
      },
    };
    const eventsPayload: CurrentEventsResponse = { events: dashboardPayload.events };
    const events = normalizeEventRows(eventsPayload);
    const warnings = normalizeDashboardWarnings(dashboardPayload.warnings);

    if (!dashboardPayload.events) {
      warnings.push('Dashboard snapshot did not include lifecycle events; showing anomaly-derived warnings only.');
    }

    return {
      window,
      effectiveWindow,
      snapshotAt,
      summary,
      tokens: normalizeDashboardTokenRows(summary, dashboardPayload.tokens),
      buyers: normalizeDashboardBuyerRows(summary, dashboardPayload.buyers),
      anomalies,
      events: events.length > 0 ? events : synthesizeAnomalyEvents(snapshotAt, anomalies),
      capabilities: baseCapabilities({
        supports5hWindow: true,
        buyersComplete: true,
        buyerSeriesAvailable: true,
        lifecycleEventsAvailable: Boolean(dashboardPayload.events),
      }),
      warnings,
    };
  }

  const snapshotAt = new Date().toISOString();

  const [system, usage, health, routing, anomalies, buyersPayload, eventsPayload] = await Promise.all([
    fetchAdminJson<CurrentSystemResponse>('/v1/admin/analytics/system', { window: effectiveWindow }),
    fetchAdminJson<CurrentTokensResponse<CurrentTokenUsageRow>>('/v1/admin/analytics/tokens', { window: effectiveWindow }),
    fetchAdminJson<CurrentTokensResponse<CurrentTokenHealthRow>>('/v1/admin/analytics/tokens/health', { window: effectiveWindow }),
    fetchAdminJson<CurrentTokensResponse<CurrentTokenRoutingRow>>('/v1/admin/analytics/tokens/routing', { window: effectiveWindow }),
    fetchAdminJson<CurrentAnomaliesResponse>('/v1/admin/analytics/anomalies', { window: effectiveWindow }),
    fetchOptionalAdminJson<CurrentBuyersResponse>('/v1/admin/analytics/buyers', { window: effectiveWindow }),
    fetchOptionalAdminJson<CurrentEventsResponse>('/v1/admin/analytics/events', { window: effectiveWindow }),
  ]);

  const summary = normalizeSummary(system);
  const tokens = buildTokenRows(summary, usage, health, routing);
  const buyers = await normalizeBuyerRows(summary, buyersPayload, system.topBuyers);
  const events = normalizeEventRows(eventsPayload);
  const warnings: string[] = [];

  if (!buyers.complete) {
    warnings.push('Buyer table is currently limited to the system summary top-buyers set.');
  }
  if (!eventsPayload) {
    warnings.push('Lifecycle events endpoint is not available yet; only anomaly-derived warnings are shown.');
  }

  return {
    window,
    effectiveWindow,
    snapshotAt,
    summary,
    tokens,
    buyers: buyers.rows,
    anomalies,
    events: events.length > 0 ? events : synthesizeAnomalyEvents(snapshotAt, anomalies),
    capabilities: baseCapabilities({
      supports5hWindow: true,
      buyersComplete: buyers.complete,
      buyerSeriesAvailable: false,
      lifecycleEventsAvailable: Boolean(eventsPayload),
    }),
    warnings,
  };
}

function metricValue(metric: AnalyticsMetric, point: Record<string, unknown>): number {
  if (metric === 'usageUnits') return toNumber(point.usageUnits);
  if (metric === 'requests') return toNumber(point.requests);
  if (metric === 'latencyP50Ms') return toNumber(point.latencyP50Ms);
  return toNumber(point.errorRate);
}

function normalizeSeriesPoints(
  metric: AnalyticsMetric,
  rawSeries: Array<Record<string, unknown>> | undefined,
): AnalyticsSeriesPoint[] {
  return (rawSeries ?? [])
    .map((point) => {
      const timestamp = toStringOrNull(point.date ?? point.bucket);
      if (!timestamp) return null;
      return {
        timestamp,
        value: metricValue(metric, point),
      } satisfies AnalyticsSeriesPoint;
    })
    .filter((point): point is AnalyticsSeriesPoint => point !== null);
}

export async function getAnalyticsSeries(input: {
  entityType: 'token' | 'buyer';
  entityId: string;
  metric: AnalyticsMetric;
  window: AnalyticsPageWindow;
}): Promise<AnalyticsSeriesResponse> {
  const effectiveWindow = pageWindowToApiWindow(input.window);

  if (input.entityType === 'token') {
    const payload = await fetchAdminJson<CurrentTokenSeriesResponse>('/v1/admin/analytics/timeseries', {
      window: effectiveWindow,
      credentialId: input.entityId,
    });

    return {
      window: input.window,
      effectiveWindow,
      entityType: input.entityType,
      entityId: input.entityId,
      metric: input.metric,
      series: normalizeSeriesPoints(input.metric, payload.series as Array<Record<string, unknown>> | undefined),
      partial: false,
      warning: null,
    };
  }

  const payload = await fetchOptionalAdminJson<CurrentBuyerSeriesResponse>('/v1/admin/analytics/buyers/timeseries', {
    window: effectiveWindow,
    apiKeyId: input.entityId,
  });

  if (!payload) {
    return {
      window: input.window,
      effectiveWindow,
      entityType: input.entityType,
      entityId: input.entityId,
      metric: input.metric,
      series: [],
      partial: true,
      warning: 'Buyer historical series endpoint is not available from the current backend.',
    };
  }

  return {
    window: input.window,
    effectiveWindow,
    entityType: input.entityType,
    entityId: input.entityId,
    metric: input.metric,
    series: normalizeSeriesPoints(input.metric, payload.series as Array<Record<string, unknown>> | undefined),
    partial: false,
    warning: null,
  };
}
