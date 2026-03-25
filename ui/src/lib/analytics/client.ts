'use client';

import type {
  AnalyticsDashboardSnapshot,
  AnalyticsMetric,
  AnalyticsPageWindow,
  AnalyticsSeriesResponse,
} from './types';
import { extractAnalyticsErrorMessage, safeParseAnalyticsBody } from './errorSummary';

export class AnalyticsClientError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'AnalyticsClientError';
    this.status = status;
    this.details = details ?? null;
  }
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  const body = text.length > 0 ? safeParseAnalyticsBody(text) : null;

  if (!response.ok) {
    const message = extractAnalyticsErrorMessage(body) ?? `Analytics request failed (${response.status})`;
    throw new AnalyticsClientError(response.status, message, body);
  }

  return body as T;
}

type DashboardFetchOptions = {
  dashboardPath?: string;
  signal?: AbortSignal;
};

type TimeseriesFetchOptions = {
  timeseriesPath?: string;
};

export function fetchAnalyticsDashboard(window: AnalyticsPageWindow, opts?: DashboardFetchOptions | AbortSignal) {
  opts = opts instanceof AbortSignal ? { signal: opts } : opts;
  const searchParams = new URLSearchParams({ window });
  const dashboardPath = opts?.dashboardPath ?? '/api/analytics/dashboard';
  return fetchJson<AnalyticsDashboardSnapshot>(`${dashboardPath}?${searchParams.toString()}`, {
    signal: opts?.signal,
  });
}

export function fetchAnalyticsSeries(input: {
  entityType: 'token' | 'buyer';
  entityId: string;
  metric: AnalyticsMetric;
  analyticsWindow: AnalyticsPageWindow;
  signal?: AbortSignal;
}, opts?: TimeseriesFetchOptions) {
  const searchParams = new URLSearchParams({
    window: input.analyticsWindow,
    entityType: input.entityType,
    entityId: input.entityId,
    metric: input.metric,
  });
  const timeseriesPath = opts?.timeseriesPath ?? '/api/analytics/timeseries';

  return fetchJson<AnalyticsSeriesResponse>(`${timeseriesPath}?${searchParams.toString()}`, {
    signal: input.signal,
  });
}
