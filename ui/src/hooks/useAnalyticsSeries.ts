'use client';

import { startTransition, useEffect, useState } from 'react';
import { fetchAnalyticsSeries } from '../lib/analytics/client';
import type {
  AnalyticsMetric,
  AnalyticsPageWindow,
  AnalyticsSeries,
  AnalyticsSeriesSelection,
} from '../lib/analytics/types';
import { MAX_ANALYTICS_SERIES } from '../lib/analytics/types';

type UseAnalyticsSeriesResult = {
  series: AnalyticsSeries[];
  loading: boolean;
  error: string | null;
  warnings: string[];
};

const SERIES_POLL_MS = 10000;

export function useAnalyticsSeries(input: {
  window: AnalyticsPageWindow;
  metric: AnalyticsMetric;
  selections: AnalyticsSeriesSelection[];
  paused?: boolean;
}): UseAnalyticsSeriesResult {
  const [series, setSeries] = useState<AnalyticsSeries[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const selected = input.selections.slice(0, MAX_ANALYTICS_SERIES);
  const selectionKey = selected.map((entry) => `${entry.entityType}:${entry.entityId}:${entry.label}`).join('|');

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
    let activeControllers: AbortController[] = [];

    const scheduleNext = () => {
      if (cancelled || input.paused || selected.length === 0) return;
      timeoutId = globalThis.setTimeout(() => {
        void runCycle(false);
      }, SERIES_POLL_MS);
    };

    const runCycle = async (initialLoad: boolean) => {
      if (cancelled || input.paused) return;

      activeControllers.forEach((controller) => controller.abort());
      activeControllers = selected.map(() => new AbortController());

      if (initialLoad) {
        startTransition(() => {
          setLoading(true);
          setError(null);
        });
      }

      const settled = await Promise.allSettled(
        selected.map((selection, index) =>
          fetchAnalyticsSeries({
            entityType: selection.entityType,
            entityId: selection.entityId,
            metric: input.metric,
            analyticsWindow: input.window,
            signal: activeControllers[index]?.signal,
          }),
        ),
      );

      if (cancelled) return;

      const nextSeries: AnalyticsSeries[] = [];
      const nextWarnings: string[] = [];
      let nextError: string | null = null;

      settled.forEach((result, index) => {
        const selection = selected[index];
        if (!selection) return;

        if (result.status === 'fulfilled') {
          if (result.value.warning) nextWarnings.push(`${selection.label}: ${result.value.warning}`);
          nextSeries.push({
            entityType: selection.entityType,
            entityId: selection.entityId,
            label: selection.label,
            metric: input.metric,
            points: result.value.series,
            partial: result.value.partial,
          });
          return;
        }

        const reason = result.reason instanceof Error ? result.reason.message : `Failed to load ${selection.label}`;
        nextWarnings.push(`${selection.label}: ${reason}`);
        if (!nextError && selection.entityType === 'token') {
          nextError = reason;
        }
      });

      startTransition(() => {
        setSeries(nextSeries);
        setWarnings(nextWarnings);
        setError(nextError);
        setLoading(false);
      });

      scheduleNext();
    };

    if (selected.length === 0) {
      startTransition(() => {
        setSeries([]);
        setWarnings([]);
        setError(null);
        setLoading(false);
      });
      return () => {
        cancelled = true;
        activeControllers.forEach((controller) => controller.abort());
        if (timeoutId) globalThis.clearTimeout(timeoutId);
      };
    }

    if (input.paused) {
      startTransition(() => {
        setLoading(false);
      });
      return () => {
        cancelled = true;
        activeControllers.forEach((controller) => controller.abort());
        if (timeoutId) globalThis.clearTimeout(timeoutId);
      };
    }

    void runCycle(true);

    return () => {
      cancelled = true;
      activeControllers.forEach((controller) => controller.abort());
      if (timeoutId) globalThis.clearTimeout(timeoutId);
    };
  }, [input.metric, input.paused, input.window, selectionKey]);

  return {
    series,
    loading,
    error,
    warnings,
  };
}
