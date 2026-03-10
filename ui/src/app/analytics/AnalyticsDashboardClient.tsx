'use client';

import { useEffect, useState } from 'react';
import { AnalyticsChart } from '../../components/analytics/AnalyticsChart';
import { BuyerTable, TokenTable } from '../../components/analytics/AnalyticsTables';
import { useAnalyticsDashboard } from '../../hooks/useAnalyticsDashboard';
import { useAnalyticsSeries } from '../../hooks/useAnalyticsSeries';
import {
  DEFAULT_BUYER_SORT,
  DEFAULT_TOKEN_SORT,
  sortBuyerRows,
  sortTokenRows,
  toggleSort,
  type BuyerSortKey,
  type SortState,
  type TokenSortKey,
} from '../../lib/analytics/sort';
import {
  buyerSeriesLabel,
  formatCount,
  formatPercent,
  formatTimestamp,
  metricLabel,
  seriesValueLabel,
} from '../../lib/analytics/present';
import {
  ANALYTICS_PAGE_WINDOWS,
  MAX_ANALYTICS_SERIES,
  type AnalyticsMetric,
  type AnalyticsPageWindow,
} from '../../lib/analytics/types';
import styles from './page.module.css';

type SeriesMode = 'token' | 'buyer';

const TOKEN_SERIES_METRICS: AnalyticsMetric[] = ['usageUnits', 'requests', 'latencyP50Ms', 'errorRate'];
const BUYER_SERIES_METRICS: AnalyticsMetric[] = ['usageUnits', 'requests'];

function toggleSelection(current: string[], id: string): string[] {
  if (current.includes(id)) {
    return current.filter((entry) => entry !== id);
  }
  if (current.length >= MAX_ANALYTICS_SERIES) {
    return [...current.slice(1), id];
  }
  return [...current, id];
}

function isActiveTokenStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === 'active' || normalized === 'rotating';
}

function defaultSelectedIds(ids: string[]): string[] {
  return ids.slice(0, Math.min(4, ids.length));
}

function commandLabel(input: {
  window: AnalyticsPageWindow;
  seriesMode: SeriesMode;
  metric: AnalyticsMetric;
}): string {
  return `watch analytics --window ${input.window} --mode ${input.seriesMode} --metric ${metricLabel(input.metric).toLowerCase()}`;
}

export function AnalyticsDashboardClient() {
  const dashboard = useAnalyticsDashboard('24h');
  const snapshot = dashboard.snapshot;
  const [seriesMode, setSeriesMode] = useState<SeriesMode>('token');
  const [metric, setMetric] = useState<AnalyticsMetric>('usageUnits');
  const [tokenSort, setTokenSort] = useState<SortState<TokenSortKey>>(DEFAULT_TOKEN_SORT);
  const [buyerSort, setBuyerSort] = useState<SortState<BuyerSortKey>>(DEFAULT_BUYER_SORT);
  const [selectedTokenIds, setSelectedTokenIds] = useState<string[]>([]);
  const [selectedBuyerIds, setSelectedBuyerIds] = useState<string[]>([]);

  useEffect(() => {
    if (!snapshot) return;

    const activeTokenIds = snapshot.tokens
      .filter((row) => isActiveTokenStatus(row.status))
      .map((row) => row.credentialId);
    const visibleBuyerIds = snapshot.buyers
      .filter((row) => row.requests > 0)
      .map((row) => row.apiKeyId);

    setSelectedTokenIds((current) => {
      const valid = current.filter((id) => activeTokenIds.includes(id));
      return valid.length > 0 ? valid.slice(0, MAX_ANALYTICS_SERIES) : defaultSelectedIds(activeTokenIds);
    });

    setSelectedBuyerIds((current) => {
      const valid = current.filter((id) => visibleBuyerIds.includes(id));
      return valid.length > 0 ? valid.slice(0, MAX_ANALYTICS_SERIES) : defaultSelectedIds(visibleBuyerIds);
    });
  }, [snapshot]);

  const activeTokenRows = sortTokenRows(
    (snapshot?.tokens ?? []).filter((row) => isActiveTokenStatus(row.status)),
    tokenSort,
  );
  const visibleBuyerRows = sortBuyerRows(
    (snapshot?.buyers ?? []).filter((row) => row.requests > 0),
    buyerSort,
  );

  const availableMetrics = seriesMode === 'token' ? TOKEN_SERIES_METRICS : BUYER_SERIES_METRICS;

  useEffect(() => {
    if (availableMetrics.includes(metric)) return;
    setMetric(availableMetrics[0]);
  }, [availableMetrics, metric]);

  const tokenSelections = activeTokenRows
    .filter((row) => selectedTokenIds.includes(row.credentialId))
    .map((row) => ({
      entityType: 'token' as const,
      entityId: row.credentialId,
      label: row.debugLabel ?? row.displayKey,
    }));

  const buyerSelections = visibleBuyerRows
    .filter((row) => selectedBuyerIds.includes(row.apiKeyId))
    .map((row) => ({
      entityType: 'buyer' as const,
      entityId: row.apiKeyId,
      label: buyerSeriesLabel(row),
    }));

  const series = useAnalyticsSeries({
    window: dashboard.window,
    metric,
    paused: dashboard.paused,
    selections: seriesMode === 'token' ? tokenSelections : buyerSelections,
  });
  const supports5h = snapshot?.capabilities.supports5hWindow ?? false;
  const loadingLabel = dashboard.paused ? 'Polling paused.' : `Waiting for ${dashboard.window.toUpperCase()} analytics snapshot.`;

  return (
    <div className={styles.console}>
      <header className={styles.consoleHeader}>
        <div className={styles.headerBlock}>
          <div className={styles.kicker}>INNIES / ANALYTICS</div>
          <h1 className={styles.title}>terminal monitor</h1>
          <div className={styles.promptLine}>
            <span className={styles.promptPrefix}>ops@innies:~$</span>
            <span>{commandLabel({ window: dashboard.window, seriesMode, metric })}</span>
          </div>
        </div>

        <div className={styles.liveMeta}>
          <span className={`${styles.liveBadge} ${styles[`liveBadge_${dashboard.liveStatus}`]}`}>
            <span className={styles.liveDot} />
            {dashboard.liveStatus.toUpperCase()}
          </span>
          <span className={styles.liveText}>LAST {formatTimestamp(dashboard.lastSuccessfulUpdateAt)} UTC</span>
        </div>
      </header>

      <div className={styles.toolbar}>
        <div className={styles.segmented}>
          {ANALYTICS_PAGE_WINDOWS.map((window) => (
            <button
              key={window}
              className={
                window === '5h' && !supports5h
                  ? styles.windowButtonDisabled
                  : window === dashboard.window
                    ? styles.windowButtonActive
                    : styles.windowButton
              }
              disabled={window === '5h' && !supports5h}
              onClick={() => dashboard.setWindow(window)}
              type="button"
            >
              {window.toUpperCase()}
            </button>
          ))}
        </div>

        <div className={styles.segmented}>
          <button
            className={seriesMode === 'token' ? styles.windowButtonActive : styles.windowButton}
            onClick={() => setSeriesMode('token')}
            type="button"
          >
            TOKENS
          </button>
          <button
            className={seriesMode === 'buyer' ? styles.windowButtonActive : styles.windowButton}
            onClick={() => setSeriesMode('buyer')}
            type="button"
          >
            BUYERS
          </button>
        </div>

        <div className={styles.segmented}>
          {availableMetrics.map((entry) => (
            <button
              key={entry}
              className={metric === entry ? styles.windowButtonActive : styles.windowButton}
              onClick={() => setMetric(entry)}
              type="button"
            >
              {metricLabel(entry).toUpperCase()}
            </button>
          ))}
        </div>

        <div className={styles.segmented}>
          <button className={styles.controlButton} onClick={() => dashboard.setPaused(!dashboard.paused)} type="button">
            {dashboard.paused ? 'RESUME' : 'PAUSE'}
          </button>
          <button className={styles.controlButton} onClick={dashboard.refresh} type="button">
            REFRESH
          </button>
        </div>
      </div>

      {dashboard.error ? (
        <div className={`${styles.statusLine} ${styles.statusLineError}`}>{dashboard.error}</div>
      ) : null}

      {!snapshot ? (
        <div className={`${styles.statusLine} ${styles.statusLineDim}`}>{loadingLabel}</div>
      ) : (
        <>
          <section className={`${styles.section} ${styles.chartSection}`}>
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitle}>TRACE BUFFER</div>
              <div className={styles.sectionMeta}>
                {seriesMode.toUpperCase()} · {metricLabel(metric).toUpperCase()} · {formatCount(series.series.length)}/{MAX_ANALYTICS_SERIES} TRACKED
              </div>
            </div>

            {series.error ? <div className={styles.noticeError}>{series.error}</div> : null}
            {series.warnings.length > 0 ? (
              <div className={styles.noticeList}>
                {series.warnings.map((warning) => (
                  <div key={warning} className={styles.noticeText}>
                    {warning}
                  </div>
                ))}
              </div>
            ) : null}

            <AnalyticsChart metric={metric} series={series.series} loading={series.loading} />

            {series.series.length === 0 ? (
              <div className={styles.emptyStateText}>
                Select up to {MAX_ANALYTICS_SERIES} rows below to stream history here.
              </div>
            ) : (
              <div className={styles.seriesRail}>
                {series.series.map((entry) => {
                  const latest = entry.points.at(-1)?.value ?? 0;
                  return (
                    <div key={`${entry.entityType}-${entry.entityId}`} className={styles.seriesRow}>
                      <span className={styles.seriesLabel}>{entry.label}</span>
                      <span className={styles.seriesValue}>{seriesValueLabel(metric, latest)}</span>
                      {entry.partial ? <span className={styles.partialBadge}>PARTIAL</span> : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className={styles.summaryStrip}>
            <div className={styles.summaryItem}>
              <div className={styles.summaryLabel}>TOTAL REQS</div>
              <div className={styles.summaryValue}>{formatCount(snapshot.summary.totalRequests)}</div>
            </div>
            <div className={styles.summaryItem}>
              <div className={styles.summaryLabel}>TOTAL UNITS</div>
              <div className={styles.summaryValue}>{formatCount(snapshot.summary.totalUsageUnits)}</div>
            </div>
            <div className={styles.summaryItem}>
              <div className={styles.summaryLabel}>ACTIVE TOKENS</div>
              <div className={styles.summaryValue}>{formatCount(snapshot.summary.activeTokens)}</div>
            </div>
            <div className={styles.summaryItem}>
              <div className={styles.summaryLabel}>MAXED TOKENS</div>
              <div className={styles.summaryValue}>{formatCount(snapshot.summary.maxedTokens)}</div>
            </div>
            <div className={styles.summaryItem}>
              <div className={styles.summaryLabel}>ERROR RATE</div>
              <div className={styles.summaryValue}>{formatPercent(snapshot.summary.errorRate)}</div>
            </div>
            <div className={styles.summaryItem}>
              <div className={styles.summaryLabel}>FALLBACK</div>
              <div className={styles.summaryValue}>{formatPercent(snapshot.summary.fallbackRate)}</div>
            </div>
          </section>

          <div className={styles.tableGrid}>
            <section className={`${styles.section} ${styles.tableSection}`}>
              <div className={styles.sectionHeader}>
                <div className={styles.sectionTitle}>ACTIVE TOKEN CREDS</div>
                <div className={styles.sectionMeta}>{formatCount(activeTokenRows.length)} VISIBLE</div>
              </div>
              <TokenTable
                onSort={(key, defaultDirection) => setTokenSort((current) => toggleSort(current, key, defaultDirection))}
                onToggle={(id) => setSelectedTokenIds((current) => toggleSelection(current, id))}
                rows={activeTokenRows}
                selectedIds={selectedTokenIds}
                sort={tokenSort}
              />
            </section>

            <section className={`${styles.section} ${styles.tableSection}`}>
              <div className={styles.sectionHeader}>
                <div className={styles.sectionTitle}>BUYER KEYS</div>
                <div className={styles.sectionMeta}>
                  {snapshot.capabilities.buyersComplete ? 'REQUESTS > 0' : 'TOP BUYERS · REQUESTS > 0'}
                </div>
              </div>
              <BuyerTable
                onSort={(key, defaultDirection) => setBuyerSort((current) => toggleSort(current, key, defaultDirection))}
                onToggle={(id) => setSelectedBuyerIds((current) => toggleSelection(current, id))}
                rows={visibleBuyerRows}
                selectedIds={selectedBuyerIds}
                sort={buyerSort}
              />
            </section>
          </div>

          <div className={styles.eventGrid}>
            <section className={styles.section}>
              <div className={styles.sectionHeader}>
                <div className={styles.sectionTitle}>SYSTEM NOTES</div>
                <div className={styles.sectionMeta}>{formatCount(snapshot.warnings.length)} FLAGS</div>
              </div>
              <div className={styles.noticeList}>
                {snapshot.warnings.length === 0 ? (
                  <div className={styles.noticeText}>Snapshot bridge stable. No current integration warnings.</div>
                ) : (
                  snapshot.warnings.map((warning) => (
                    <div key={warning} className={styles.noticeText}>
                      {warning}
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className={styles.section}>
              <div className={styles.sectionHeader}>
                <div className={styles.sectionTitle}>EVENT LOG</div>
                <div className={styles.sectionMeta}>{formatCount(snapshot.events.length)} ENTRIES</div>
              </div>
              <div className={styles.eventList}>
                {snapshot.events.length === 0 ? (
                  <div className={styles.noticeText}>No active warnings in the current snapshot.</div>
                ) : (
                  snapshot.events.map((event) => (
                    <div key={event.id} className={styles.eventItem}>
                      <div className={styles.eventMeta}>
                        <span className={styles.eventSeverity}>{event.severity.toUpperCase()}</span>
                        <span>{formatTimestamp(event.createdAt)} UTC</span>
                        <span>{event.type}</span>
                      </div>
                      <div className={styles.eventSummary}>{event.summary}</div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
