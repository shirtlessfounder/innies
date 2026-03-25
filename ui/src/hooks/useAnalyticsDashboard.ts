'use client';

import { startTransition, useEffect, useRef, useState } from 'react';
import { fetchAnalyticsDashboard } from '../lib/analytics/client';
import type {
  AnalyticsBuyerRow,
  AnalyticsDashboardSnapshot,
  AnalyticsLiveStatus,
  AnalyticsPageWindow,
  AnalyticsTokenRow,
} from '../lib/analytics/types';

type UseAnalyticsDashboardResult = {
  snapshot: AnalyticsDashboardSnapshot | null;
  window: AnalyticsPageWindow;
  setWindow: (window: AnalyticsPageWindow) => void;
  paused: boolean;
  setPaused: (paused: boolean) => void;
  liveStatus: AnalyticsLiveStatus;
  error: string | null;
  lastSuccessfulUpdateAt: string | null;
  refresh: () => void;
};

function pollIntervalMs(window: AnalyticsPageWindow): number {
  switch (window) {
    case '24h':
      return 2000;
    case '1w':
      return 4000;
    case '1m':
      return 8000;
    case '5h':
    default:
      return 2000;
  }
}

function applyTokenDeltas(
  nextRows: AnalyticsTokenRow[],
  previousRows: AnalyticsTokenRow[] | undefined,
  flashToken: string,
): AnalyticsTokenRow[] {
  const previousMap = new Map((previousRows ?? []).map((row) => [row.credentialId, row]));
  return nextRows.map((row) => {
    const previous = previousMap.get(row.credentialId);
    const deltaUsageUnits = previous ? Math.max(0, row.usageUnits - previous.usageUnits) : 0;
    const deltaAttempts = previous ? Math.max(0, row.attempts - previous.attempts) : 0;
    return {
      ...row,
      deltaUsageUnits,
      deltaAttempts,
      flashToken: deltaUsageUnits > 0 || deltaAttempts > 0 ? flashToken : null,
    };
  });
}

function applyBuyerDeltas(
  nextRows: AnalyticsBuyerRow[],
  previousRows: AnalyticsBuyerRow[] | undefined,
  flashToken: string,
): AnalyticsBuyerRow[] {
  const previousMap = new Map((previousRows ?? []).map((row) => [row.apiKeyId, row]));
  return nextRows.map((row) => {
    const previous = previousMap.get(row.apiKeyId);
    const deltaUsageUnits = previous ? Math.max(0, row.usageUnits - previous.usageUnits) : 0;
    const deltaRequests = previous ? Math.max(0, row.requests - previous.requests) : 0;
    return {
      ...row,
      deltaUsageUnits,
      deltaRequests,
      flashToken: deltaUsageUnits > 0 || deltaRequests > 0 ? flashToken : null,
    };
  });
}

function applyDashboardDeltas(
  nextSnapshot: AnalyticsDashboardSnapshot,
  previousSnapshot: AnalyticsDashboardSnapshot | null,
): AnalyticsDashboardSnapshot {
  const flashToken = nextSnapshot.snapshotAt;
  return {
    ...nextSnapshot,
    tokens: applyTokenDeltas(nextSnapshot.tokens, previousSnapshot?.tokens, flashToken),
    buyers: applyBuyerDeltas(nextSnapshot.buyers, previousSnapshot?.buyers, flashToken),
  };
}

export function useAnalyticsDashboard(
  initialWindow: AnalyticsPageWindow = '24h',
  input?: { dashboardPath?: string },
): UseAnalyticsDashboardResult {
  const [selectedWindow, setSelectedWindow] = useState<AnalyticsPageWindow>(initialWindow);
  const [snapshot, setSnapshot] = useState<AnalyticsDashboardSnapshot | null>(null);
  const [paused, setPaused] = useState(false);
  const [liveStatus, setLiveStatus] = useState<AnalyticsLiveStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [lastSuccessfulUpdateAt, setLastSuccessfulUpdateAt] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const previousSnapshotRef = useRef<AnalyticsDashboardSnapshot | null>(null);
  const snapshotRef = useRef<AnalyticsDashboardSnapshot | null>(null);

  useEffect(() => {
    previousSnapshotRef.current = null;
  }, [selectedWindow]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
    let activeController: AbortController | null = null;

    const scheduleNext = () => {
      if (cancelled || paused) return;
      timeoutId = globalThis.setTimeout(() => {
        void runCycle(false);
      }, pollIntervalMs(selectedWindow));
    };

    const runCycle = async (initialLoad: boolean) => {
      if (cancelled || paused) return;

      activeController?.abort();
      activeController = new AbortController();

      if (initialLoad) {
        startTransition(() => {
          setLiveStatus('loading');
          setError(null);
        });
      }

      try {
        const nextSnapshot = await fetchAnalyticsDashboard(selectedWindow, {
          dashboardPath: input?.dashboardPath,
          signal: activeController.signal,
        });
        if (cancelled) return;

        const withDeltas = applyDashboardDeltas(nextSnapshot, previousSnapshotRef.current);
        previousSnapshotRef.current = withDeltas;
        snapshotRef.current = withDeltas;

        startTransition(() => {
          setSnapshot(withDeltas);
          setError(null);
          setLiveStatus('live');
          setLastSuccessfulUpdateAt(withDeltas.snapshotAt);
        });
      } catch (fetchError) {
        if (cancelled) return;
        if (fetchError instanceof Error && fetchError.name === 'AbortError') return;

        startTransition(() => {
          setError(fetchError instanceof Error ? fetchError.message : 'Failed to refresh analytics');
          setLiveStatus(paused ? 'paused' : 'degraded');
        });
      } finally {
        scheduleNext();
      }
    };

    if (paused) {
      startTransition(() => {
        setLiveStatus(snapshotRef.current ? 'paused' : 'loading');
      });
      return () => {
        cancelled = true;
        activeController?.abort();
        if (timeoutId) globalThis.clearTimeout(timeoutId);
      };
    }

    void runCycle(true);

    return () => {
      cancelled = true;
      activeController?.abort();
      if (timeoutId) globalThis.clearTimeout(timeoutId);
    };
  }, [selectedWindow, paused, refreshNonce, input?.dashboardPath]);

  return {
    snapshot,
    window: selectedWindow,
    setWindow: (window) => {
      if (window === selectedWindow) return;

      previousSnapshotRef.current = null;
      snapshotRef.current = null;

      startTransition(() => {
        setSelectedWindow(window);
        setSnapshot(null);
        setError(null);
        setLastSuccessfulUpdateAt(null);
        setLiveStatus(paused ? 'paused' : 'loading');
      });
    },
    paused,
    setPaused,
    liveStatus,
    error,
    lastSuccessfulUpdateAt,
    refresh: () => setRefreshNonce((value) => value + 1),
  };
}
