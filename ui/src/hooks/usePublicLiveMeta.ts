'use client';

import { startTransition, useEffect, useState } from 'react';
import type { AnalyticsLiveStatus } from '../lib/analytics/types';

type PublicLiveMetaResponse = {
  liveStatus?: AnalyticsLiveStatus;
  lastSuccessfulUpdateAt?: string | null;
};

type PublicLiveMeta = {
  liveStatus: AnalyticsLiveStatus;
  lastSuccessfulUpdateAt: string | null;
};

const POLL_INTERVAL_MS = 15000;

export function usePublicLiveMeta(): PublicLiveMeta {
  const [liveStatus, setLiveStatus] = useState<AnalyticsLiveStatus>('loading');
  const [lastSuccessfulUpdateAt, setLastSuccessfulUpdateAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
    let activeController: AbortController | null = null;

    const scheduleNext = () => {
      if (cancelled) return;
      timeoutId = globalThis.setTimeout(() => {
        void runCycle();
      }, POLL_INTERVAL_MS);
    };

    const runCycle = async () => {
      activeController?.abort();
      activeController = new AbortController();

      try {
        const response = await fetch('/api/live-meta', {
          cache: 'no-store',
          headers: { accept: 'application/json' },
          signal: activeController.signal,
        });
        const payload = await response.json() as PublicLiveMetaResponse;
        if (cancelled) return;

        startTransition(() => {
          setLiveStatus(payload.liveStatus ?? 'degraded');
          setLastSuccessfulUpdateAt(payload.lastSuccessfulUpdateAt ?? null);
        });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof Error && error.name === 'AbortError') return;

        startTransition(() => {
          setLiveStatus('degraded');
        });
      } finally {
        scheduleNext();
      }
    };

    void runCycle();

    return () => {
      cancelled = true;
      activeController?.abort();
      if (timeoutId) globalThis.clearTimeout(timeoutId);
    };
  }, []);

  return {
    liveStatus,
    lastSuccessfulUpdateAt,
  };
}
