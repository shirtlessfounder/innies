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

export function fetchAnalyticsDashboard(window: AnalyticsPageWindow, signal?: AbortSignal) {
  const searchParams = new URLSearchParams({ window });
  return fetchJson<AnalyticsDashboardSnapshot>(`/api/analytics/dashboard?${searchParams.toString()}`, { signal });
}

export function fetchAnalyticsSeries(input: {
  entityType: 'token' | 'buyer';
  entityId: string;
  metric: AnalyticsMetric;
  analyticsWindow: AnalyticsPageWindow;
  signal?: AbortSignal;
}) {
  const searchParams = new URLSearchParams({
    window: input.analyticsWindow,
    entityType: input.entityType,
    entityId: input.entityId,
    metric: input.metric,
  });

  return fetchJson<AnalyticsSeriesResponse>(`/api/analytics/timeseries?${searchParams.toString()}`, {
    signal: input.signal,
  });
}
