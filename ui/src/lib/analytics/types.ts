export const ANALYTICS_PAGE_WINDOWS = ['5h', '24h', '1w', '1m'] as const;
export const ACTIVE_ANALYTICS_PAGE_WINDOWS = ['24h', '1w', '1m'] as const;
export const MAX_ANALYTICS_SERIES = 6;

export type AnalyticsPageWindow = typeof ANALYTICS_PAGE_WINDOWS[number];
export type AnalyticsApiWindow = '5h' | '24h' | '7d' | '1m' | 'all';
export type AnalyticsEntityType = 'token' | 'buyer';
export type AnalyticsMetric = 'usageUnits' | 'requests' | 'latencyP50Ms' | 'errorRate';
export type AnalyticsSeverity = 'info' | 'warn' | 'error';
export type AnalyticsLiveStatus = 'loading' | 'live' | 'paused' | 'degraded';

export type AnalyticsSummary = {
  totalRequests: number;
  totalUsageUnits: number;
  activeTokens: number;
  maxedTokens: number;
  errorRate: number;
  fallbackRate: number;
  latencyP50Ms: number | null;
  ttfbP50Ms: number | null;
};

export type AnalyticsTokenRow = {
  credentialId: string;
  displayKey: string;
  debugLabel: string | null;
  provider: string;
  status: string;
  attempts: number;
  requests: number;
  usageUnits: number;
  percentOfWindow: number;
  utilizationRate24h: number | null;
  maxedEvents7d: number;
  monthlyContributionUsedUnits: number;
  monthlyContributionLimitUnits: number | null;
  latencyP50Ms: number | null;
  errorRate: number | null;
  authFailures24h: number;
  rateLimited24h: number;
  deltaAttempts: number;
  deltaUsageUnits: number;
  flashToken: string | null;
};

export type AnalyticsBuyerRow = {
  apiKeyId: string;
  displayKey: string;
  label: string | null;
  orgId: string;
  orgLabel: string | null;
  preferredProvider: string | null;
  effectiveProvider: string | null;
  requests: number;
  usageUnits: number;
  percentOfWindow: number;
  lastSeenAt: string | null;
  latencyP50Ms: number | null;
  errorRate: number | null;
  deltaRequests: number;
  deltaUsageUnits: number;
  flashToken: string | null;
  isPartialData: boolean;
};

export type AnalyticsAnomalyChecks = {
  missingDebugLabels: number;
  unresolvedCredentialIdsInTokenModeUsage: number;
  nullCredentialIdsInRouting: number;
  staleAggregateWindows: number | null;
  usageLedgerVsAggregateMismatchCount: number | null;
};

export type AnalyticsAnomalies = {
  ok: boolean;
  checks: AnalyticsAnomalyChecks;
};

export type AnalyticsEventRow = {
  id: string;
  type: string;
  createdAt: string;
  provider: string | null;
  credentialId: string | null;
  credentialLabel: string | null;
  summary: string;
  severity: AnalyticsSeverity;
  statusCode: number | null;
  reason: string | null;
  metadata: Record<string, unknown>;
};

export type AnalyticsCapabilities = {
  supports5hWindow: boolean;
  buyersComplete: boolean;
  buyerSeriesAvailable: boolean;
  lifecycleEventsAvailable: boolean;
  dashboardSnapshotAvailable: boolean;
  timeseriesMultiEntityAvailable: boolean;
};

export type AnalyticsDashboardSnapshot = {
  window: AnalyticsPageWindow;
  effectiveWindow: AnalyticsApiWindow;
  snapshotAt: string;
  summary: AnalyticsSummary;
  tokens: AnalyticsTokenRow[];
  buyers: AnalyticsBuyerRow[];
  anomalies: AnalyticsAnomalies;
  events: AnalyticsEventRow[];
  capabilities: AnalyticsCapabilities;
  warnings: string[];
};

export type AnalyticsSeriesPoint = {
  timestamp: string;
  value: number;
};

export type AnalyticsSeries = {
  entityType: AnalyticsEntityType;
  entityId: string;
  label: string;
  metric: AnalyticsMetric;
  points: AnalyticsSeriesPoint[];
  partial: boolean;
};

export type AnalyticsAggregateSeries = {
  id: string;
  label: string;
  points: AnalyticsSeriesPoint[];
  partial: boolean;
  color: string;
  kind: 'total' | 'provider';
};

export type AnalyticsSeriesResponse = {
  window: AnalyticsPageWindow;
  effectiveWindow: AnalyticsApiWindow;
  entityType: AnalyticsEntityType;
  entityId: string;
  metric: AnalyticsMetric;
  series: AnalyticsSeriesPoint[];
  partial: boolean;
  warning: string | null;
};

export type AnalyticsSeriesSelection = {
  entityType: AnalyticsEntityType;
  entityId: string;
  label: string;
};
