'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { TbEye, TbEyeClosed } from 'react-icons/tb';
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
  analyticsEventIdentityLabel,
  analyticsEventReasonLabel,
  buyerSeriesLabel,
  formatCount,
  formatLocalTimeZoneAbbreviation,
  formatPercent,
  formatTimestamp,
  metricLabel,
  seriesValueLabel,
  tokenProviderLabel,
  tokenProviderKey,
  tokenSeriesLabel,
} from '../../lib/analytics/present';
import {
  ANALYTICS_PAGE_WINDOWS,
  type AnalyticsAggregateSeries,
  type AnalyticsEventRow,
  type AnalyticsSeries,
  type AnalyticsSeriesPoint,
  type AnalyticsMetric,
  type AnalyticsPageWindow,
} from '../../lib/analytics/types';
import styles from './page.module.css';

type SeriesMode = 'token' | 'buyer';

const TOKEN_SERIES_METRICS: AnalyticsMetric[] = ['usageUnits', 'requests', 'latencyP50Ms', 'errorRate'];
const BUYER_SERIES_METRICS: AnalyticsMetric[] = ['usageUnits', 'requests', 'latencyP50Ms', 'errorRate'];

function toggleHidden(current: string[], id: string): string[] {
  if (current.includes(id)) {
    return current.filter((entry) => entry !== id);
  }
  return [...current, id];
}

function isVisibleTokenStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized !== 'expired' && normalized !== 'revoked';
}

function sortSeriesPoints(left: AnalyticsSeriesPoint, right: AnalyticsSeriesPoint): number {
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.timestamp.localeCompare(right.timestamp);
}

function buildAggregateSeries(input: {
  id: string;
  label: string;
  metric: AnalyticsMetric;
  series: AnalyticsSeries[];
  color: string;
  kind: AnalyticsAggregateSeries['kind'];
}): AnalyticsAggregateSeries | null {
  const { color, id, kind, label, metric, series } = input;
  if (metric !== 'usageUnits' && metric !== 'requests') return null;
  if (series.length === 0) return null;

  const bucket = new Map<string, number>();
  let partial = false;

  for (const entry of series) {
    partial ||= entry.partial;
    for (const point of entry.points) {
      bucket.set(point.timestamp, (bucket.get(point.timestamp) ?? 0) + point.value);
    }
  }

  const points = [...bucket.entries()]
    .map(([timestamp, value]) => ({ timestamp, value }))
    .sort(sortSeriesPoints);

  if (points.length === 0) return null;

  return {
    id,
    label,
    points,
    partial,
    color,
    kind,
  };
}

function tokenProviderAggregateLabel(provider: 'claude' | 'codex'): string {
  return provider.toUpperCase();
}

function tokenProviderAggregateColor(provider: 'claude' | 'codex'): string {
  return provider === 'codex' ? '#1f6f8b' : '#5d7124';
}

function tokenMetricSortKey(metric: AnalyticsMetric): TokenSortKey {
  switch (metric) {
    case 'requests':
      return 'attempts';
    case 'latencyP50Ms':
      return 'latencyP50Ms';
    case 'errorRate':
      return 'errorRate';
    case 'usageUnits':
    default:
      return 'usageUnits';
  }
}

function buyerMetricSortKey(metric: AnalyticsMetric): BuyerSortKey {
  switch (metric) {
    case 'requests':
      return 'requests';
    case 'latencyP50Ms':
      return 'latencyP50Ms';
    case 'errorRate':
      return 'errorRate';
    case 'usageUnits':
    default:
      return 'usageUnits';
  }
}

function commandLabel(input: {
  window: AnalyticsPageWindow;
  seriesMode: SeriesMode;
  metric: AnalyticsMetric;
}): string {
  return `watch analytics --window ${input.window} --mode ${input.seriesMode} --metric ${metricLabel(input.metric).toLowerCase()}`;
}

function SeriesVisibilityButton(input: {
  hidden: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      aria-label={`${input.hidden ? 'Show' : 'Hide'} ${input.label} on chart`}
      className={[
        styles.seriesToggle,
        input.hidden ? styles.seriesToggleHidden : '',
      ].filter(Boolean).join(' ')}
      onClick={input.onClick}
      type="button"
    >
      {input.hidden ? (
        <TbEyeClosed className={styles.seriesToggleIcon} aria-hidden="true" />
      ) : (
        <TbEye className={styles.seriesToggleIcon} aria-hidden="true" />
      )}
    </button>
  );
}

function readMetadataTimestamp(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function appendUniqueNote(notes: string[], value: string | null): void {
  if (!value || notes.includes(value)) return;
  notes.push(value);
}

function summarizeTraceWarnings(warnings: string[], primaryReason?: string | null): string[] {
  const grouped = new Map<string, string[]>();
  const normalizedPrimaryReason = primaryReason?.trim().toLowerCase() ?? null;

  for (const warning of warnings) {
    const separator = warning.indexOf(': ');
    const label = separator > 0 ? warning.slice(0, separator).trim() : '';
    const reason = separator > 0 ? warning.slice(separator + 2).trim() : warning.trim();
    if (!reason) continue;
    if (normalizedPrimaryReason && reason.trim().toLowerCase() === normalizedPrimaryReason) continue;
    const labels = grouped.get(reason) ?? [];
    if (label) labels.push(label);
    grouped.set(reason, labels);
  }

  return [...grouped.entries()].slice(0, 4).map(([reason, labels]) => {
    if (labels.length <= 1) {
      return `Trace fetch degraded${labels[0] ? ` for ${labels[0]}` : ''}: ${reason}`;
    }
    return `Trace fetch degraded for ${formatCount(labels.length)} traces: ${reason}`;
  });
}

function eventDetailLabel(event: AnalyticsEventRow): string | null {
  const parts: string[] = [];
  const identity = analyticsEventIdentityLabel(event);
  if (identity) parts.push(identity);

  const provider = tokenProviderLabel(event.provider);
  if (provider !== '--') parts.push(provider);

  if (typeof event.statusCode === 'number') {
    parts.push(`status ${event.statusCode}`);
  }

  const reason = analyticsEventReasonLabel(event.reason);
  if (reason && reason.toLowerCase() !== (typeof event.statusCode === 'number' ? `status ${event.statusCode}` : '')) {
    parts.push(reason);
  }

  const nextProbeAt = readMetadataTimestamp(event.metadata, 'nextProbeAt');
  if (nextProbeAt) {
    parts.push(`next ${formatTimestamp(nextProbeAt)} ${formatLocalTimeZoneAbbreviation(nextProbeAt)}`);
  }

  return parts.length > 0 ? parts.join(' / ') : null;
}

export function AnalyticsDashboardClient() {
  const dashboard = useAnalyticsDashboard('24h');
  const snapshot = dashboard.snapshot;
  const [seriesMode, setSeriesMode] = useState<SeriesMode>('token');
  const [metric, setMetric] = useState<AnalyticsMetric>('usageUnits');
  const [tokenSort, setTokenSort] = useState<SortState<TokenSortKey>>(DEFAULT_TOKEN_SORT);
  const [buyerSort, setBuyerSort] = useState<SortState<BuyerSortKey>>(DEFAULT_BUYER_SORT);
  const [hiddenTokenIds, setHiddenTokenIds] = useState<string[]>([]);
  const [hiddenBuyerIds, setHiddenBuyerIds] = useState<string[]>([]);
  const [hiddenAggregateIds, setHiddenAggregateIds] = useState<string[]>([]);

  useEffect(() => {
    if (!snapshot) return;

    const visibleTokenIds = snapshot.tokens
      .filter((row) => isVisibleTokenStatus(row.status))
      .map((row) => row.credentialId);
    const visibleBuyerIds = snapshot.buyers
      .filter((row) => row.requests > 0)
      .map((row) => row.apiKeyId);

    setHiddenTokenIds((current) => current.filter((id) => visibleTokenIds.includes(id)));
    setHiddenBuyerIds((current) => current.filter((id) => visibleBuyerIds.includes(id)));
  }, [snapshot]);

  const visibleTokenRows = sortTokenRows(
    (snapshot?.tokens ?? []).filter((row) => isVisibleTokenStatus(row.status)),
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

  useEffect(() => {
    const dynamicTokenKeys: TokenSortKey[] = ['usageUnits', 'attempts', 'latencyP50Ms', 'errorRate'];
    const nextKey = tokenMetricSortKey(metric);
    setTokenSort((current) => dynamicTokenKeys.includes(current.key)
      ? { key: nextKey, direction: 'desc' }
      : current);

    const dynamicBuyerKeys: BuyerSortKey[] = ['usageUnits', 'requests', 'latencyP50Ms', 'errorRate'];
    const nextBuyerKey = buyerMetricSortKey(metric);
    setBuyerSort((current) => dynamicBuyerKeys.includes(current.key)
      ? { key: nextBuyerKey, direction: 'desc' }
      : current);
  }, [metric]);

  const tokenSelections = visibleTokenRows
    .map((row) => ({
      entityType: 'token' as const,
      entityId: row.credentialId,
      label: tokenSeriesLabel(row),
    }));

  const buyerSelections = visibleBuyerRows
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
  const tokenProviderById = new Map(
    visibleTokenRows.map((row) => [row.credentialId, tokenProviderKey(row.provider)] as const),
  );
  const hiddenSeriesIds = seriesMode === 'token' ? hiddenTokenIds : hiddenBuyerIds;
  const visibleSeries = series.series.filter((entry) => !hiddenSeriesIds.includes(entry.entityId));
  const aggregateSeries = [
    buildAggregateSeries({
      id: 'total',
      label: 'TOTAL',
      metric,
      series: series.series,
      color: '#1b2f38',
      kind: 'total',
    }),
    ...(seriesMode === 'token'
      ? (['codex', 'claude'] as const).map((provider) =>
          buildAggregateSeries({
            id: provider,
            label: tokenProviderAggregateLabel(provider),
            metric,
            series: series.series.filter((entry) => tokenProviderById.get(entry.entityId) === provider),
            color: tokenProviderAggregateColor(provider),
            kind: 'provider',
          }),
        )
      : []),
  ].filter((entry): entry is AnalyticsAggregateSeries => entry !== null);
  const visibleAggregateSeries = aggregateSeries.filter((entry) => !hiddenAggregateIds.includes(entry.id));
  const shownTraceCount = visibleSeries.length + visibleAggregateSeries.length;
  const supports5h = snapshot?.capabilities.supports5hWindow ?? false;
  const loadingLabel = dashboard.paused ? 'Polling paused.' : `Waiting for ${dashboard.window.toUpperCase()} analytics snapshot.`;
  const transientSystemNotes: string[] = [];

  if (snapshot && dashboard.error) {
    appendUniqueNote(transientSystemNotes, `Dashboard refresh degraded: ${dashboard.error}`);
  }
  if (snapshot && series.error) {
    appendUniqueNote(transientSystemNotes, `Trace polling degraded: ${series.error}`);
  }
  if (snapshot) {
    for (const warning of summarizeTraceWarnings(series.warnings, series.error)) {
      appendUniqueNote(transientSystemNotes, warning);
    }
  }

  const systemNotes = snapshot
    ? [...transientSystemNotes, ...snapshot.warnings.filter((warning) => !transientSystemNotes.includes(warning))]
    : [];

  return (
    <div className={styles.console}>
      <header className={styles.consoleHeader}>
        <div className={styles.headerBlock}>
          <div className={styles.kicker}>
            <Link className={styles.homeLink} href="/">
              INNIES.COMPUTER
            </Link>
            <span> / ANALYTICS</span>
          </div>
          <h1 className={styles.title}>monitor the innies</h1>
          <div className={styles.promptLine}>
            <span className={styles.promptPrefix}>innies:~$</span>
            <span className={styles.promptCommand}>
              <span className={styles.promptCommandText}>
                {commandLabel({ window: dashboard.window, seriesMode, metric })}
                <span className={styles.promptCursor} aria-hidden="true" />
              </span>
            </span>
          </div>
        </div>

        <div className={styles.liveMeta}>
          <span className={`${styles.liveBadge} ${styles[`liveBadge_${dashboard.liveStatus}`]}`}>
            <span className={styles.liveDot} />
            {dashboard.liveStatus.toUpperCase()}
          </span>
          <span className={styles.liveText}>
            LAST {formatTimestamp(dashboard.lastSuccessfulUpdateAt)} {formatLocalTimeZoneAbbreviation(dashboard.lastSuccessfulUpdateAt)}
          </span>
        </div>
      </header>

      <div className={styles.toolbar}>
        <div className={styles.toolbarMain}>
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
        </div>

        <div className={styles.toolbarActions}>
          <button className={styles.controlButton} onClick={() => dashboard.setPaused(!dashboard.paused)} type="button">
            {dashboard.paused ? 'RESUME' : 'PAUSE'}
          </button>
          <button className={styles.controlButton} onClick={dashboard.refresh} type="button">
            REFRESH
          </button>
        </div>
      </div>

      {dashboard.error && !snapshot ? (
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
                {seriesMode.toUpperCase()} · {metricLabel(metric).toUpperCase()} · {formatCount(shownTraceCount)} SHOWN
              </div>
            </div>

            <AnalyticsChart metric={metric} series={visibleSeries} aggregates={visibleAggregateSeries} loading={series.loading} />

            {visibleSeries.length === 0 && visibleAggregateSeries.length === 0 ? (
              <div className={styles.emptyStateText}>
                All traces are hidden. Toggle an eye below to restore a line.
              </div>
            ) : (
              <div className={styles.seriesRail}>
                {aggregateSeries.map((entry) => {
                  const hidden = hiddenAggregateIds.includes(entry.id);
                  return (
                    <div key={entry.id} className={`${styles.seriesRow} ${styles.seriesRowTotal} ${hidden ? styles.seriesRowHidden : ''}`}>
                      <SeriesVisibilityButton
                        hidden={hidden}
                        label={entry.label}
                        onClick={() => setHiddenAggregateIds((current) => toggleHidden(current, entry.id))}
                      />
                      <span className={styles.seriesLabel}>{entry.label}</span>
                      <span className={styles.seriesValue}>{seriesValueLabel(metric, entry.points.at(-1)?.value ?? 0)}</span>
                      {entry.partial ? <span className={styles.partialBadge}>PARTIAL</span> : null}
                    </div>
                  );
                })}
                {series.series.map((entry) => {
                  const latest = entry.points.at(-1)?.value ?? 0;
                  const hidden = hiddenSeriesIds.includes(entry.entityId);
                  return (
                    <div
                      key={`${entry.entityType}-${entry.entityId}`}
                      className={`${styles.seriesRow} ${hidden ? styles.seriesRowHidden : ''}`}
                    >
                      <SeriesVisibilityButton
                        hidden={hidden}
                        label={entry.label}
                        onClick={() => (
                          seriesMode === 'token'
                            ? setHiddenTokenIds((current) => toggleHidden(current, entry.entityId))
                            : setHiddenBuyerIds((current) => toggleHidden(current, entry.entityId))
                        )}
                      />
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
              <div className={styles.summaryLabel}>BENCHED TOKENS</div>
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
                <div className={styles.sectionTitle}>TOKEN CREDS (innies)</div>
                <div className={styles.sectionMeta}>{formatCount(visibleTokenRows.length)} VISIBLE</div>
              </div>
              <TokenTable
                metric={metric}
                onSort={(key, defaultDirection) => setTokenSort((current) => toggleSort(current, key, defaultDirection))}
                hiddenIds={hiddenTokenIds}
                rows={visibleTokenRows}
                sort={tokenSort}
              />
            </section>

            <section className={`${styles.section} ${styles.tableSection}`}>
              <div className={styles.sectionHeader}>
                <div className={styles.sectionTitle}>BUYER KEYS (outies)</div>
                <div className={styles.sectionMeta}>
                  {snapshot.capabilities.buyersComplete
                    ? `${formatCount(visibleBuyerRows.length)} ACTIVE`
                    : `TOP BUYERS · ${formatCount(visibleBuyerRows.length)} ACTIVE`}
                </div>
              </div>
              <BuyerTable
                metric={metric}
                onSort={(key, defaultDirection) => setBuyerSort((current) => toggleSort(current, key, defaultDirection))}
                hiddenIds={hiddenBuyerIds}
                rows={visibleBuyerRows}
                sort={buyerSort}
              />
            </section>
          </div>

          <div className={styles.eventGrid}>
            <section className={styles.section}>
              <div className={styles.sectionHeader}>
                <div className={styles.sectionTitle}>SYSTEM NOTES</div>
                <div className={styles.sectionMeta}>{formatCount(systemNotes.length)} FLAGS</div>
              </div>
              <div className={`${styles.noticeList} ${styles.systemNotesList}`}>
                {systemNotes.length === 0 ? (
                  <div className={styles.noticeText}>No current dashboard warnings in this snapshot.</div>
                ) : (
                  systemNotes.map((warning) => (
                    <div key={warning} className={styles.noticeText}>
                      {warning}
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className={styles.section}>
              <div className={styles.sectionHeader}>
                <div className={styles.sectionTitle}>OPS LOG</div>
                <div className={styles.sectionMeta}>{formatCount(snapshot.events.length)} ENTRIES</div>
              </div>
              <div className={`${styles.eventList} ${styles.opsLogList}`}>
                {snapshot.events.length === 0 ? (
                  <div className={styles.noticeText}>No recent lifecycle events in the current snapshot.</div>
                ) : (
                  snapshot.events.map((event) => {
                    const detail = eventDetailLabel(event);
                    return (
                      <div key={event.id} className={styles.eventItem}>
                        <div className={styles.eventMeta}>
                          <span className={styles.eventSeverity}>{event.severity.toUpperCase()}</span>
                          <span>{formatTimestamp(event.createdAt)} {formatLocalTimeZoneAbbreviation(event.createdAt)}</span>
                          <span>{event.type}</span>
                        </div>
                        <div className={styles.eventSummary}>{event.summary}</div>
                        {detail ? <div className={styles.eventDetail}>{detail}</div> : null}
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
