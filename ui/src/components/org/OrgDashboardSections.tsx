'use client';

import { useEffect, useState } from 'react';
import styles from './orgDashboard.module.css';
import { OrgDashboardTokens } from './OrgDashboardTokens';
import { OrgDashboardMembers } from './OrgDashboardMembers';
import type { AnalyticsDashboardSnapshot } from '../../lib/analytics/types';
import type { OrgDashboardPageState } from '../../lib/org/types';

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function fetchAnalyticsSnapshot(path: string, signal: AbortSignal): Promise<AnalyticsDashboardSnapshot> {
  const searchParams = new URLSearchParams({ window: '24h' });
  const response = await fetch(`${path}?${searchParams.toString()}`, {
    cache: 'no-store',
    signal,
    headers: {
      accept: 'application/json',
    },
  });
  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) {
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : null;
    const message = typeof record?.message === 'string' ? record.message : `Analytics request failed (${response.status})`;
    throw new Error(message);
  }
  return body as AnalyticsDashboardSnapshot;
}

function OrgAnalyticsSection(input: {
  dashboardPath: string;
  timeseriesPath: string;
}) {
  const [snapshot, setSnapshot] = useState<AnalyticsDashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);

    void fetchAnalyticsSnapshot(input.dashboardPath, controller.signal)
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
      })
      .catch((fetchError) => {
        if (fetchError instanceof Error && fetchError.name === 'AbortError') return;
        setError(fetchError instanceof Error ? fetchError.message : 'Could not load analytics.');
      });

    return () => controller.abort();
  }, [input.dashboardPath]);

  return (
    <section className={styles.section} data-series-path={input.timeseriesPath}>
      <div className={styles.sectionHeader}>
        <div>
          <h2 className={styles.sectionTitle}>Analytics</h2>
          <p className={styles.sectionHint}>
            Org-scoped dashboard summary, loaded from the current route&apos;s analytics proxy instead of the old global analytics surface.
          </p>
        </div>
      </div>

      {error ? <p className={styles.errorBox}>{error}</p> : null}

      {!snapshot && !error ? (
        <div className={styles.emptyState}>Loading analytics...</div>
      ) : null}

      {snapshot ? (
        <>
          <div className={styles.heroStats}>
            <div className={styles.statCard}>
              <p className={styles.statLabel}>Requests</p>
              <p className={styles.statValue}>{snapshot.summary.totalRequests}</p>
            </div>
            <div className={styles.statCard}>
              <p className={styles.statLabel}>Usage Units</p>
              <p className={styles.statValue}>{snapshot.summary.totalUsageUnits}</p>
            </div>
            <div className={styles.statCard}>
              <p className={styles.statLabel}>Active Tokens</p>
              <p className={styles.statValue}>{snapshot.summary.activeTokens}</p>
            </div>
            <div className={styles.statCard}>
              <p className={styles.statLabel}>Error Rate</p>
              <p className={styles.statValue}>{formatPercent(snapshot.summary.errorRate)}</p>
            </div>
          </div>
          {snapshot.warnings.length > 0 ? (
            <ul className={styles.warningList}>
              {snapshot.warnings.map((warning) => (
                <li className={styles.warnPill} key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function OrgDashboardSections(input: { data: OrgDashboardPageState }) {
  const { data } = input;
  const roleLabel = data.membership.isOwner ? 'Owner' : 'Member';

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <section className={styles.hero}>
          <div className={styles.heroTop}>
            <div>
              <div className={styles.eyebrow}>{data.org.slug}</div>
              <h1 className={styles.title}>{data.org.name}</h1>
              <p className={styles.lede}>
                Org-scoped analytics, token inventory, and membership controls live here. Owner-only actions stay visible only when the membership role allows them.
              </p>
            </div>
            <div className={styles.heroActions}>
              <span className={styles.goodPill}>Role {roleLabel}</span>
              <span className={styles.pill}>Members {data.members.length}</span>
              <span className={styles.pill}>Pending {data.pendingInvites.length}</span>
            </div>
          </div>

          <div className={styles.heroStats}>
            <div className={styles.statCard}>
              <p className={styles.statLabel}>Org</p>
              <p className={styles.statValue}>{data.org.slug}</p>
            </div>
            <div className={styles.statCard}>
              <p className={styles.statLabel}>Tokens</p>
              <p className={styles.statValue}>{data.tokens.length}</p>
            </div>
            <div className={styles.statCard}>
              <p className={styles.statLabel}>Members</p>
              <p className={styles.statValue}>{data.members.length}</p>
            </div>
            <div className={styles.statCard}>
              <p className={styles.statLabel}>Role</p>
              <p className={styles.statValue}>{roleLabel}</p>
            </div>
          </div>
        </section>

        <div className={styles.grid}>
          <OrgAnalyticsSection
            dashboardPath={data.analyticsPaths.dashboardPath}
            timeseriesPath={data.analyticsPaths.timeseriesPath}
          />
          <OrgDashboardTokens
            membership={data.membership}
            org={data.org}
            tokenPermissions={data.tokenPermissions}
            tokens={data.tokens}
          />
          <OrgDashboardMembers
            members={data.members}
            membership={data.membership}
            org={data.org}
            pendingInvites={data.pendingInvites}
          />
        </div>
      </div>
    </main>
  );
}
