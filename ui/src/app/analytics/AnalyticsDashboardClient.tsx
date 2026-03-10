'use client';

import { useEffect, useState } from 'react';
import { AnalyticsChart } from '../../components/analytics/AnalyticsChart';
import { useAnalyticsDashboard } from '../../hooks/useAnalyticsDashboard';
import { useAnalyticsSeries } from '../../hooks/useAnalyticsSeries';
import {
  DEFAULT_BUYER_SORT,
  DEFAULT_TOKEN_SORT,
  sortBuyerRows,
  sortTokenRows,
  toggleSort,
  type BuyerSortKey,
  type SortDirection,
  type SortState,
  type TokenSortKey,
} from '../../lib/analytics/sort';
import {
  ANALYTICS_PAGE_WINDOWS,
  MAX_ANALYTICS_SERIES,
  type AnalyticsBuyerRow,
  type AnalyticsMetric,
  type AnalyticsSeriesPoint,
  type AnalyticsTokenRow,
} from '../../lib/analytics/types';
import styles from './page.module.css';

type SeriesMode = 'token' | 'buyer';

const TOKEN_SERIES_METRICS: AnalyticsMetric[] = ['usageUnits', 'requests', 'latencyP50Ms', 'errorRate'];
const BUYER_SERIES_METRICS: AnalyticsMetric[] = ['usageUnits', 'requests'];

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--';
  return `${(value * 100).toFixed(value >= 0.1 ? 1 : 2)}%`;
}

function formatNullableNumber(value: number | null | undefined, suffix = ''): string {
  if (value === null || value === undefined) return '--';
  return `${formatCount(Math.round(value))}${suffix}`;
}

function formatTimestamp(value: string | null | undefined): string {
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

function toggleSelection(current: string[], id: string): string[] {
  if (current.includes(id)) {
    return current.filter((entry) => entry !== id);
  }
  if (current.length >= MAX_ANALYTICS_SERIES) {
    return [...current.slice(1), id];
  }
  return [...current, id];
}

function metricLabel(metric: AnalyticsMetric): string {
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

function seriesValueLabel(metric: AnalyticsMetric, value: number): string {
  if (metric === 'errorRate') return formatPercent(value);
  if (metric === 'latencyP50Ms') return formatNullableNumber(value, 'ms');
  return formatCount(value);
}

function buyerIdentityLabel(row: AnalyticsBuyerRow): string {
  return row.label ?? row.displayKey;
}

function buyerSeriesLabel(row: AnalyticsBuyerRow): string {
  return row.label ? `${row.label} (${row.displayKey})` : row.displayKey;
}

function buyerOrgLabel(row: AnalyticsBuyerRow): string {
  return row.orgLabel ?? row.orgId;
}

function sortAria(active: boolean, direction: SortDirection): 'ascending' | 'descending' | 'none' {
  if (!active) return 'none';
  return direction === 'asc' ? 'ascending' : 'descending';
}

function sortGlyph(active: boolean, direction: SortDirection): string {
  if (!active) return '-';
  return direction === 'asc' ? '^' : 'v';
}

function SortHeaderButton(input: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onClick: () => void;
  numeric?: boolean;
}) {
  return (
    <button
      className={[
        styles.sortButton,
        input.active ? styles.sortButtonActive : '',
        input.numeric ? styles.sortButtonNumeric : '',
      ].filter(Boolean).join(' ')}
      onClick={input.onClick}
      type="button"
    >
      <span>{input.label}</span>
      <span className={input.active ? styles.sortGlyphActive : styles.sortGlyph}>{sortGlyph(input.active, input.direction)}</span>
    </button>
  );
}

function Sparkline({ points }: { points: AnalyticsSeriesPoint[] }) {
  if (points.length < 2) {
    return <div className={styles.sparklineEmpty}>NO SERIES</div>;
  }

  const width = 160;
  const height = 34;
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const polyline = points
    .map((point, index) => {
      const x = (index / Math.max(1, points.length - 1)) * width;
      const y = height - ((point.value - min) / range) * height;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <svg className={styles.sparkline} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={polyline} />
    </svg>
  );
}

function DeltaCell(input: {
  value: number;
  flashToken: string | null;
  prefix?: string;
  suffix?: string;
}) {
  if (input.value <= 0) return <span className={styles.deltaIdle}>+0</span>;
  return (
    <span
      key={`${input.flashToken ?? 'delta'}-${input.value}`}
      className={styles.deltaLive}
    >
      {input.prefix ?? '+'}
      {formatCount(input.value)}
      {input.suffix ?? ''}
    </span>
  );
}

function TokenTable({
  rows,
  selectedIds,
  onToggle,
  sort,
  onSort,
}: {
  rows: AnalyticsTokenRow[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  sort: SortState<TokenSortKey>;
  onSort: (key: TokenSortKey, defaultDirection: SortDirection) => void;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th />
            <th aria-sort={sortAria(sort.key === 'displayKey', sort.direction)}>
              <SortHeaderButton
                active={sort.key === 'displayKey'}
                direction={sort.direction}
                label="Token"
                onClick={() => onSort('displayKey', 'asc')}
              />
            </th>
            <th aria-sort={sortAria(sort.key === 'debugLabel', sort.direction)}>
              <SortHeaderButton
                active={sort.key === 'debugLabel'}
                direction={sort.direction}
                label="Label"
                onClick={() => onSort('debugLabel', 'asc')}
              />
            </th>
            <th aria-sort={sortAria(sort.key === 'provider', sort.direction)}>
              <SortHeaderButton
                active={sort.key === 'provider'}
                direction={sort.direction}
                label="Provider"
                onClick={() => onSort('provider', 'asc')}
              />
            </th>
            <th aria-sort={sortAria(sort.key === 'status', sort.direction)}>
              <SortHeaderButton
                active={sort.key === 'status'}
                direction={sort.direction}
                label="Status"
                onClick={() => onSort('status', 'asc')}
              />
            </th>
            <th className={styles.numeric} aria-sort={sortAria(sort.key === 'attempts', sort.direction)}>
              <SortHeaderButton
                active={sort.key === 'attempts'}
                direction={sort.direction}
                label="Attempts"
                numeric
                onClick={() => onSort('attempts', 'desc')}
              />
            </th>
            <th className={styles.numeric} aria-sort={sortAria(sort.key === 'usageUnits', sort.direction)}>
              <SortHeaderButton
                active={sort.key === 'usageUnits'}
                direction={sort.direction}
                label="Usage"
                numeric
                onClick={() => onSort('usageUnits', 'desc')}
              />
            </th>
            <th className={styles.numeric}>Delta</th>
            <th className={styles.numeric} aria-sort={sortAria(sort.key === 'utilizationRate24h', sort.direction)}>
              <SortHeaderButton
                active={sort.key === 'utilizationRate24h'}
                direction={sort.direction}
                label="Util 24h"
                numeric
                onClick={() => onSort('utilizationRate24h', 'desc')}
              />
            </th>
            <th className={styles.numeric} aria-sort={sortAria(sort.key === 'maxedEvents7d', sort.direction)}>
              <SortHeaderButton
                active={sort.key === 'maxedEvents7d'}
                direction={sort.direction}
                label="Maxed 7d"
                numeric
                onClick={() => onSort('maxedEvents7d', 'desc')}
              />
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.credentialId} className={selectedIds.includes(row.credentialId) ? styles.rowSelected : undefined}>
              <td>
                <input
                  aria-label={`Track ${row.displayKey}`}
                  checked={selectedIds.includes(row.credentialId)}
                  onChange={() => onToggle(row.credentialId)}
                  type="checkbox"
                />
              </td>
              <td>{row.displayKey}</td>
              <td>{row.debugLabel ?? '--'}</td>
              <td>{row.provider}</td>
              <td>{row.status}</td>
              <td className={styles.numeric}>{formatCount(row.attempts)}</td>
              <td className={styles.numeric}>{formatCount(row.usageUnits)}</td>
              <td className={styles.numeric}>
                <DeltaCell value={row.deltaUsageUnits} flashToken={row.flashToken} />
              </td>
              <td className={styles.numeric}>{formatPercent(row.utilizationRate24h)}</td>
              <td className={styles.numeric}>{formatCount(row.maxedEvents7d)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BuyerTable({
  rows,
  selectedIds,
  onToggle,
  sort,
  onSort,
}: {
  rows: AnalyticsBuyerRow[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  sort: SortState<BuyerSortKey>;
  onSort: (key: BuyerSortKey, defaultDirection: SortDirection) => void;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th />
            <th aria-sort={sortAria(sort.key === 'label', sort.direction)}>
              <SortHeaderButton
                active={sort.key === 'label'}
                direction={sort.direction}
                label="Buyer"
                onClick={() => onSort('label', 'asc')}
              />
            </th>
            <th aria-sort={sortAria(sort.key === 'org', sort.direction)}>
              <SortHeaderButton
                active={sort.key === 'org'}
                direction={sort.direction}
                label="Org"
                onClick={() => onSort('org', 'asc')}
              />
            </th>
            <th aria-sort={sortAria(sort.key === 'effectiveProvider', sort.direction)}>
              <SortHeaderButton
                active={sort.key === 'effectiveProvider'}
                direction={sort.direction}
                label="Effective"
                onClick={() => onSort('effectiveProvider', 'asc')}
              />
            </th>
            <th className={styles.numeric} aria-sort={sortAria(sort.key === 'requests', sort.direction)}>
              <SortHeaderButton
                active={sort.key === 'requests'}
                direction={sort.direction}
                label="Requests"
                numeric
                onClick={() => onSort('requests', 'desc')}
              />
            </th>
            <th className={styles.numeric} aria-sort={sortAria(sort.key === 'usageUnits', sort.direction)}>
              <SortHeaderButton
                active={sort.key === 'usageUnits'}
                direction={sort.direction}
                label="Usage"
                numeric
                onClick={() => onSort('usageUnits', 'desc')}
              />
            </th>
            <th className={styles.numeric}>Delta</th>
            <th className={styles.numeric} aria-sort={sortAria(sort.key === 'percentOfWindow', sort.direction)}>
              <SortHeaderButton
                active={sort.key === 'percentOfWindow'}
                direction={sort.direction}
                label="Share"
                numeric
                onClick={() => onSort('percentOfWindow', 'desc')}
              />
            </th>
            <th aria-sort={sortAria(sort.key === 'lastSeenAt', sort.direction)}>
              <SortHeaderButton
                active={sort.key === 'lastSeenAt'}
                direction={sort.direction}
                label="Last Seen"
                onClick={() => onSort('lastSeenAt', 'desc')}
              />
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.apiKeyId} className={selectedIds.includes(row.apiKeyId) ? styles.rowSelected : undefined}>
              <td>
                <input
                  aria-label={`Track ${buyerSeriesLabel(row)}`}
                  checked={selectedIds.includes(row.apiKeyId)}
                  onChange={() => onToggle(row.apiKeyId)}
                  type="checkbox"
                />
              </td>
              <td>
                <div className={styles.identityCell}>
                  <span className={styles.identityPrimary}>{buyerIdentityLabel(row)}</span>
                  {row.label ? <span className={styles.identitySecondary}>{row.displayKey}</span> : null}
                </div>
              </td>
              <td>
                <div className={styles.identityCell}>
                  <span className={styles.identityPrimary}>{buyerOrgLabel(row)}</span>
                  {row.orgLabel && row.orgId !== row.orgLabel ? (
                    <span className={styles.identitySecondary}>{row.orgId}</span>
                  ) : null}
                </div>
              </td>
              <td>{row.effectiveProvider ?? '--'}</td>
              <td className={styles.numeric}>{formatCount(row.requests)}</td>
              <td className={styles.numeric}>{formatCount(row.usageUnits)}</td>
              <td className={styles.numeric}>
                <DeltaCell value={row.deltaUsageUnits} flashToken={row.flashToken} />
              </td>
              <td className={styles.numeric}>{formatPercent(row.percentOfWindow)}</td>
              <td>{formatTimestamp(row.lastSeenAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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

    setSelectedTokenIds((current) => {
      const valid = current.filter((id) => snapshot.tokens.some((row) => row.credentialId === id));
      if (valid.length > 0) return valid.slice(0, MAX_ANALYTICS_SERIES);
      return snapshot.tokens.slice(0, Math.min(3, snapshot.tokens.length)).map((row) => row.credentialId);
    });

    setSelectedBuyerIds((current) => {
      const valid = current.filter((id) => snapshot.buyers.some((row) => row.apiKeyId === id));
      if (valid.length > 0) return valid.slice(0, MAX_ANALYTICS_SERIES);
      return snapshot.buyers.slice(0, Math.min(3, snapshot.buyers.length)).map((row) => row.apiKeyId);
    });
  }, [snapshot]);

  const availableMetrics = seriesMode === 'token' ? TOKEN_SERIES_METRICS : BUYER_SERIES_METRICS;

  useEffect(() => {
    if (availableMetrics.includes(metric)) return;
    setMetric(availableMetrics[0]);
  }, [availableMetrics, metric]);

  const tokenSelections = (snapshot?.tokens ?? [])
    .filter((row) => selectedTokenIds.includes(row.credentialId))
    .map((row) => ({
      entityType: 'token' as const,
      entityId: row.credentialId,
      label: row.debugLabel ?? row.displayKey,
    }));

  const buyerSelections = (snapshot?.buyers ?? [])
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
  const tokenRows = sortTokenRows(snapshot?.tokens ?? [], tokenSort);
  const buyerRows = sortBuyerRows(snapshot?.buyers ?? [], buyerSort);
  const loadingLabel = dashboard.paused ? 'PAUSED' : 'LOADING';
  const loadingText = dashboard.paused
    ? `Polling paused. Resume to load ${dashboard.window.toUpperCase()} analytics snapshot.`
    : `Waiting for ${dashboard.window.toUpperCase()} analytics snapshot.`;

  return (
    <div className={styles.console}>
      <header className={styles.consoleHeader}>
        <div>
          <div className={styles.kicker}>INTERNAL ANALYTICS</div>
          <h1 className={styles.title}>Operator Console</h1>
        </div>

        <div className={styles.liveMeta}>
          <span className={`${styles.liveBadge} ${styles[`liveBadge_${dashboard.liveStatus}`]}`}>
            {dashboard.liveStatus.toUpperCase()}
          </span>
          <span className={styles.liveText}>LAST {formatTimestamp(dashboard.lastSuccessfulUpdateAt)} UTC</span>
          <button className={styles.controlButton} onClick={() => dashboard.setPaused(!dashboard.paused)} type="button">
            {dashboard.paused ? 'RESUME' : 'PAUSE'}
          </button>
          <button className={styles.controlButton} onClick={dashboard.refresh} type="button">
            REFRESH
          </button>
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
      </div>

      {dashboard.error ? (
        <section className={styles.noticePanel}>
          <div className={styles.noticeLabel}>LIVE STATUS</div>
          <div className={styles.noticeError}>{dashboard.error}</div>
        </section>
      ) : null}

      {!snapshot ? (
        <section className={styles.noticePanel}>
          <div className={styles.noticeLabel}>{loadingLabel}</div>
          <div className={styles.noticeText}>{loadingText}</div>
        </section>
      ) : (
        <>
          <section className={styles.summaryGrid}>
            <div className={styles.summaryCard}>
              <div className={styles.cardLabel}>Total Requests</div>
              <div className={styles.cardValue}>{formatCount(snapshot.summary.totalRequests)}</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.cardLabel}>Total Units</div>
              <div className={styles.cardValue}>{formatCount(snapshot.summary.totalUsageUnits)}</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.cardLabel}>Active Tokens</div>
              <div className={styles.cardValue}>{formatCount(snapshot.summary.activeTokens)}</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.cardLabel}>Maxed Tokens</div>
              <div className={styles.cardValue}>{formatCount(snapshot.summary.maxedTokens)}</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.cardLabel}>Error Rate</div>
              <div className={styles.cardValue}>{formatPercent(snapshot.summary.errorRate)}</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.cardLabel}>Fallback Rate</div>
              <div className={styles.cardValue}>{formatPercent(snapshot.summary.fallbackRate)}</div>
            </div>
          </section>

          <section className={styles.noticePanel}>
            <div className={styles.noticeLabel}>DATA NOTES</div>
            <div className={styles.noticeList}>
              {snapshot.warnings.length === 0 ? (
                <div className={styles.noticeText}>Dashboard snapshot bridge active. No current integration warnings.</div>
              ) : (
                snapshot.warnings.map((warning) => (
                  <div key={warning} className={styles.noticeText}>
                    {warning}
                  </div>
                ))
              )}
            </div>
          </section>

          <div className={styles.panelGrid}>
            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <div className={styles.panelTitle}>Token Credentials</div>
                <div className={styles.panelMeta}>{formatCount(snapshot.tokens.length)} rows</div>
              </div>
              <TokenTable
                onSort={(key, defaultDirection) => setTokenSort((current) => toggleSort(current, key, defaultDirection))}
                rows={tokenRows}
                selectedIds={selectedTokenIds}
                sort={tokenSort}
                onToggle={(id) => setSelectedTokenIds((current) => toggleSelection(current, id))}
              />
            </section>

            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <div className={styles.panelTitle}>Buyer Keys</div>
                <div className={styles.panelMeta}>
                  {snapshot.capabilities.buyersComplete ? 'full inventory' : 'top buyers fallback'}
                </div>
              </div>
              <BuyerTable
                onSort={(key, defaultDirection) => setBuyerSort((current) => toggleSort(current, key, defaultDirection))}
                rows={buyerRows}
                selectedIds={selectedBuyerIds}
                sort={buyerSort}
                onToggle={(id) => setSelectedBuyerIds((current) => toggleSelection(current, id))}
              />
            </section>
          </div>

          <div className={styles.panelGrid}>
            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <div className={styles.panelTitle}>Historical Series</div>
                <div className={styles.panelMeta}>
                  {seriesMode.toUpperCase()} · {metricLabel(metric).toUpperCase()}
                </div>
              </div>

              {series.error ? <div className={styles.noticeError}>{series.error}</div> : null}
              {series.warnings.length > 0 ? (
                <div className={styles.inlineWarnings}>
                  {series.warnings.map((warning) => (
                    <div key={warning} className={styles.noticeText}>
                      {warning}
                    </div>
                  ))}
                </div>
              ) : null}

              <AnalyticsChart metric={metric} series={series.series} loading={series.loading} />

              <div className={styles.seriesList}>
                {series.series.length === 0 ? (
                  <div className={styles.noticeText}>Select up to {MAX_ANALYTICS_SERIES} rows to inspect recent history.</div>
                ) : (
                  series.series.map((entry) => {
                    const latest = entry.points.at(-1)?.value ?? 0;
                    return (
                      <div key={`${entry.entityType}-${entry.entityId}`} className={styles.seriesCard}>
                        <div className={styles.seriesHeader}>
                          <span>{entry.label}</span>
                          <span>{seriesValueLabel(metric, latest)}</span>
                        </div>
                        <Sparkline points={entry.points} />
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <div className={styles.panelTitle}>Events & Warnings</div>
                <div className={styles.panelMeta}>
                  {snapshot.capabilities.lifecycleEventsAvailable ? 'lifecycle + anomalies' : 'anomaly-derived fallback'}
                </div>
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
