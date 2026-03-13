import type { AnalyticsBuyerRow, AnalyticsEventRow, AnalyticsMetric, AnalyticsTokenRow } from './types';

function formatShortIdentifier(value: string): string {
  const compact = value.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (compact.length < 8) return value;
  return `${compact.slice(0, 4)}...${compact.slice(-4)}`;
}

function trimBuyerPrefix(value: string): string {
  return value.startsWith('buyer-') ? value.slice('buyer-'.length) : value;
}

function remapTokenAlias(value: string): string {
  switch (value) {
    case 'darryn-codex':
      return 'darryn';
    case 'dylan-codex':
    case 'oauth-main-1':
      return 'shirtless';
    case 'niyant-codex':
    case 'oauth-main-2':
      return 'hands';
    case 'oauth-main-3':
      return 'oogway';
    case 'oauth-main-4':
      return 'aelix';
    default:
      return value;
  }
}

function trimTokenDisplayKeySuffix(value: string): string {
  return value.replace(/\s+\((?:key|cred)[^)]+\)$/i, '').trim();
}

function formatShortTokenKey(value: string): string {
  const compact = value.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (compact.length < 8) return value;
  return `cred_${compact.slice(0, 4)}...${compact.slice(-4)}`;
}

export function tokenProviderKey(provider: string | null | undefined): 'claude' | 'codex' | null {
  switch (provider?.trim().toLowerCase()) {
    case 'anthropic':
      return 'claude';
    case 'openai':
      return 'codex';
    default:
      return null;
  }
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

export function formatCompactCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--';

  const absolute = Math.abs(value);
  if (absolute < 1000) {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
  }

  const thresholds = [
    { value: 1_000_000_000, suffix: 'B' },
    { value: 1_000_000, suffix: 'M' },
    { value: 1_000, suffix: 'K' },
  ] as const;

  for (const threshold of thresholds) {
    if (absolute < threshold.value) continue;

    const scaled = value / threshold.value;
    const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
    const rounded = Number(scaled.toFixed(digits));

    return `${new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    }).format(rounded)}${threshold.suffix}`;
  }

  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--';
  return `${(value * 100).toFixed(value >= 0.1 ? 1 : 2)}%`;
}

export function formatCapPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--';
  if (value <= 0) return '0%';
  if (value >= 1) return '100%';
  return formatPercent(value);
}

export function formatContributionCapPercent(
  value: number | null | undefined,
  provider: string | null | undefined,
): string {
  if (tokenProviderKey(provider) !== 'claude') return '--';
  return formatCapPercent(value);
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
  }).replace(',', '');
}

export function formatTimeOnly(value: string | null | undefined): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '--';
  return date.toLocaleString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatLocalTimeZoneAbbreviation(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZoneName: 'short',
  }).formatToParts(date);
  const zone = parts.find((part) => part.type === 'timeZoneName')?.value?.trim();
  return zone && zone.length > 0 ? zone : '';
}

export function formatShortTimestamp(value: string | null | undefined): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '--';
  return date.toLocaleString('en-US', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
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

export function formatChartAxisValue(metric: AnalyticsMetric, value: number): string {
  if (metric === 'errorRate') return formatPercent(value);
  if (metric === 'latencyP50Ms') return `${formatCompactCount(value)}ms`;
  return formatCompactCount(value);
}

export function tokenIdentityLabel(row: AnalyticsTokenRow): string {
  return trimTokenDisplayKeySuffix(row.displayKey);
}

export function tokenLabelLabel(row: AnalyticsTokenRow): string {
  if (!row.debugLabel) return '--';
  return remapTokenAlias(trimTokenDisplayKeySuffix(row.debugLabel));
}

export function tokenDebugLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return remapTokenAlias(trimTokenDisplayKeySuffix(value));
}

export function tokenSeriesLabel(row: AnalyticsTokenRow): string {
  const base = row.debugLabel ? tokenLabelLabel(row) : tokenIdentityLabel(row);
  switch (tokenProviderKey(row.provider)) {
    case 'claude':
      return `${base}-claude`;
    case 'codex':
      return `${base}-codex`;
    default:
      return base;
  }
}

export function tokenProviderLabel(provider: string | null | undefined): string {
  switch (tokenProviderKey(provider)) {
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case undefined:
    case null:
      return '--';
    default:
      return provider ?? '--';
  }
}

export function buyerIdentityLabel(row: AnalyticsBuyerRow): string {
  return trimBuyerPrefix(row.label ?? row.displayKey);
}

export function buyerSeriesLabel(row: AnalyticsBuyerRow): string {
  return buyerIdentityLabel(row);
}

export function buyerOrgLabel(row: AnalyticsBuyerRow): string {
  if (row.orgLabel === 'Team Seller Org') return 'innies';
  return row.orgLabel ?? formatShortIdentifier(row.orgId);
}

export function buyerOrgIdLabel(row: AnalyticsBuyerRow): string {
  return formatShortIdentifier(row.orgId);
}

export function buyerPreferenceLabel(row: AnalyticsBuyerRow): string {
  switch (row.effectiveProvider) {
    case 'anthropic':
      return 'claude';
    case 'openai':
      return 'codex';
    case null:
    case undefined:
      return '--';
    default:
      return row.effectiveProvider;
  }
}

export function analyticsEventIdentityLabel(event: AnalyticsEventRow): string | null {
  const label = tokenDebugLabel(event.credentialLabel);
  const key = event.credentialId ? formatShortTokenKey(event.credentialId) : null;
  if (label && key) return `${label} (${key})`;
  return label ?? key;
}

export function analyticsEventReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;

  let normalized = reason.trim();
  if (normalized.length === 0) return null;
  if (normalized.startsWith('probe_failed:')) {
    normalized = normalized.slice('probe_failed:'.length);
  }

  normalized = normalized.replace(/^status_(\d+):(\d+)$/i, (_match, left, right) => (
    left === right ? `status ${left}` : `status ${left}/${right}`
  ));
  normalized = normalized.replace(/^status_(\d+)$/i, 'status $1');
  normalized = normalized.replace(/_/g, ' ');
  normalized = normalized.replace(/:/g, ' / ');

  return normalized;
}
