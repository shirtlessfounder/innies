import type { AnalyticsBuyerRow, AnalyticsMetric } from './types';

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--';
  return `${(value * 100).toFixed(value >= 0.1 ? 1 : 2)}%`;
}

export function formatNullableNumber(value: number | null | undefined, suffix = ''): string {
  if (value === null || value === undefined) return '--';
  return `${formatCount(Math.round(value))}${suffix}`;
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '--';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).replace(',', '');
}

export function metricLabel(metric: AnalyticsMetric): string {
  switch (metric) {
    case 'usageUnits':
      return 'Usage';
    case 'requests':
      return 'Requests';
    case 'latencyP50Ms':
      return 'Latency P50';
    case 'errorRate':
      return 'Error Rate';
    default:
      return metric;
  }
}

export function seriesValueLabel(metric: AnalyticsMetric, value: number): string {
  if (metric === 'errorRate') return formatPercent(value);
  if (metric === 'latencyP50Ms') return formatNullableNumber(value, 'ms');
  return formatCount(value);
}

export function buyerIdentityLabel(row: AnalyticsBuyerRow): string {
  return row.label ?? row.displayKey;
}

export function buyerSeriesLabel(row: AnalyticsBuyerRow): string {
  return row.label ? `${row.label} (${row.displayKey})` : row.displayKey;
}

export function buyerOrgLabel(row: AnalyticsBuyerRow): string {
  return row.orgLabel ?? row.orgId;
}
