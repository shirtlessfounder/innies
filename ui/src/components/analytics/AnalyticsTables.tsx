'use client';

import type {
  BuyerSortKey,
  SortDirection,
  SortState,
  TokenSortKey,
} from '../../lib/analytics/sort';
import { type AnalyticsBuyerRow, type AnalyticsMetric, type AnalyticsTokenRow } from '../../lib/analytics/types';
import {
  buyerIdentityLabel,
  buyerOrgIdLabel,
  buyerOrgLabel,
  buyerPreferenceLabel,
  formatCount,
  formatContributionCapPercent,
  formatNullableNumber,
  formatPercent,
  formatShortTimestamp,
  formatTimeOnly,
  formatTimestamp,
  tokenIdentityLabel,
  tokenLabelLabel,
  tokenProviderLabel,
} from '../../lib/analytics/present';
import styles from '../../app/analytics/page.module.css';

function sortAria(active: boolean, direction: SortDirection): 'ascending' | 'descending' | 'none' {
  if (!active) return 'none';
  return direction === 'asc' ? 'ascending' : 'descending';
}

function sortGlyph(active: boolean, direction: SortDirection): string {
  if (!active) return '::';
  return direction === 'asc' ? '^^' : 'vv';
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
      <span className={input.active ? styles.sortGlyphActive : styles.sortGlyph}>
        {sortGlyph(input.active, input.direction)}
      </span>
    </button>
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

function tokenStatusTone(status: string): string {
  const normalized = status.trim().toLowerCase();
  switch (normalized) {
    case 'active':
      return styles.statusPillActive;
    case 'paused':
      return styles.statusPillPaused;
    case 'rotating':
      return styles.statusPillRotating;
    case 'rate_limited':
      return styles.statusPillRateLimited;
    case 'maxed':
      return styles.statusPillMaxed;
    case 'expired':
      return styles.statusPillExpired;
    case 'revoked':
      return styles.statusPillRevoked;
    default:
      return styles.statusPillUnknown;
  }
}

function TokenStatusCell({ status }: { status: string }) {
  return (
    <span className={[styles.statusPill, tokenStatusTone(status)].join(' ')}>
      {status.replaceAll('_', ' ')}
    </span>
  );
}

function contributionCapTone(input: {
  provider: string;
  utilizationRatio: number | null;
  exhausted: boolean | null;
}): string {
  const provider = input.provider.trim().toLowerCase();
  if (provider !== 'anthropic') return '';
  if (input.exhausted === true) return styles.statusPillMaxed;
  if (input.utilizationRatio !== null && input.utilizationRatio >= 1) return styles.statusPillMaxed;
  return '';
}

function tokenMetricConfig(metric: AnalyticsMetric): {
  key: TokenSortKey;
  label: string;
  value: (row: AnalyticsTokenRow) => string;
  deltaValue: (row: AnalyticsTokenRow) => number;
  showDelta: boolean;
  showShare: boolean;
} {
  switch (metric) {
    case 'requests':
      return {
        key: 'attempts',
        label: 'Attempts',
        value: (row) => formatCount(row.attempts),
        deltaValue: (row) => row.deltaAttempts,
        showDelta: true,
        showShare: false,
      };
    case 'latencyP50Ms':
      return {
        key: 'latencyP50Ms',
        label: 'Latency P50',
        value: (row) => formatNullableNumber(row.latencyP50Ms, 'ms'),
        deltaValue: () => 0,
        showDelta: false,
        showShare: false,
      };
    case 'errorRate':
      return {
        key: 'errorRate',
        label: 'Error Rate',
        value: (row) => formatPercent(row.errorRate),
        deltaValue: () => 0,
        showDelta: false,
        showShare: false,
      };
    case 'usageUnits':
    default:
      return {
        key: 'usageUnits',
        label: 'Usage',
        value: (row) => formatCount(row.usageUnits),
        deltaValue: (row) => row.deltaUsageUnits,
        showDelta: true,
        showShare: true,
      };
  }
}

function buyerMetricConfig(metric: AnalyticsMetric): {
  key: BuyerSortKey;
  label: string;
  value: (row: AnalyticsBuyerRow) => string;
  deltaValue: (row: AnalyticsBuyerRow) => number;
  showDelta: boolean;
  showShare: boolean;
} {
  switch (metric) {
    case 'requests':
      return {
        key: 'requests',
        label: 'Requests',
        value: (row) => formatCount(row.requests),
        deltaValue: (row) => row.deltaRequests,
        showDelta: true,
        showShare: false,
      };
    case 'latencyP50Ms':
      return {
        key: 'latencyP50Ms',
        label: 'Latency P50',
        value: (row) => formatNullableNumber(row.latencyP50Ms, 'ms'),
        deltaValue: () => 0,
        showDelta: false,
        showShare: false,
      };
    case 'errorRate':
      return {
        key: 'errorRate',
        label: 'Error Rate',
        value: (row) => formatPercent(row.errorRate),
        deltaValue: () => 0,
        showDelta: false,
        showShare: false,
      };
    case 'usageUnits':
    default:
      return {
        key: 'usageUnits',
        label: 'Usage',
        value: (row) => formatCount(row.usageUnits),
        deltaValue: (row) => row.deltaUsageUnits,
        showDelta: true,
        showShare: true,
      };
  }
}

export function TokenTable({
  rows,
  hiddenIds,
  metric,
  sort,
  onSort,
}: {
  rows: AnalyticsTokenRow[];
  hiddenIds: string[];
  metric: AnalyticsMetric;
  sort: SortState<TokenSortKey>;
  onSort: (key: TokenSortKey, defaultDirection: SortDirection) => void;
}) {
  const metricConfig = tokenMetricConfig(metric);

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
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
                label="Seller"
                onClick={() => onSort('debugLabel', 'asc')}
              />
            </th>
            <th aria-sort={sortAria(sort.key === 'provider', sort.direction)}>
              <SortHeaderButton
                active={sort.key === 'provider'}
                direction={sort.direction}
                label="AI"
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
            {metricConfig.showShare ? (
              <th className={styles.numeric} aria-sort={sortAria(sort.key === 'percentOfWindow', sort.direction)}>
                <SortHeaderButton
                  active={sort.key === 'percentOfWindow'}
                  direction={sort.direction}
                  label="Share"
                  numeric
                  onClick={() => onSort('percentOfWindow', 'desc')}
                />
              </th>
            ) : null}
            <th className={styles.numeric} aria-sort={sortAria(sort.key === metricConfig.key, sort.direction)}>
              <SortHeaderButton
                active={sort.key === metricConfig.key}
                direction={sort.direction}
                label={metricConfig.label}
                numeric
                onClick={() => onSort(metricConfig.key, 'desc')}
              />
            </th>
            {metricConfig.showDelta ? <th className={styles.numeric}>Delta</th> : null}
            <th className={styles.numeric} aria-sort={sortAria(sort.key === 'fiveHourCapUsedRatio', sort.direction)}>
              <SortHeaderButton
                active={sort.key === 'fiveHourCapUsedRatio'}
                direction={sort.direction}
                label="5H"
                numeric
                onClick={() => onSort('fiveHourCapUsedRatio', 'desc')}
              />
            </th>
            <th className={styles.numeric}>5H RESET</th>
            <th className={styles.numeric} aria-sort={sortAria(sort.key === 'sevenDayCapUsedRatio', sort.direction)}>
              <SortHeaderButton
                active={sort.key === 'sevenDayCapUsedRatio'}
                direction={sort.direction}
                label="7D"
                numeric
                onClick={() => onSort('sevenDayCapUsedRatio', 'desc')}
              />
            </th>
            <th className={styles.numeric}>7D RESET</th>
            {/* Re-enable Util 24h / Maxed 7d once the token table has room for more operator-only columns again. */}
            {/* <th className={styles.numeric} aria-sort={sortAria(sort.key === 'utilizationRate24h', sort.direction)}>
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
            </th> */}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const deltaValue = metricConfig.deltaValue(row);
            const fiveHourCapTone = contributionCapTone({
              provider: row.provider,
              utilizationRatio: row.fiveHourCapUsedRatio,
              exhausted: row.fiveHourContributionCapExhausted,
            });
            const sevenDayCapTone = contributionCapTone({
              provider: row.provider,
              utilizationRatio: row.sevenDayCapUsedRatio,
              exhausted: row.sevenDayContributionCapExhausted,
            });

            return (
              <tr
                key={row.credentialId}
                className={[
                  hiddenIds.includes(row.credentialId) ? styles.rowHidden : '',
                  metricConfig.showDelta && deltaValue > 0 ? styles.rowDeltaFlash : '',
                ].filter(Boolean).join(' ')}
              >
                <td>{tokenIdentityLabel(row)}</td>
                <td>{tokenLabelLabel(row)}</td>
                <td>{tokenProviderLabel(row.provider)}</td>
                <td><TokenStatusCell status={row.status} /></td>
                {metricConfig.showShare ? <td className={styles.numeric}>{formatPercent(row.percentOfWindow)}</td> : null}
                <td className={styles.numeric}>{metricConfig.value(row)}</td>
                {metricConfig.showDelta ? (
                  <td className={styles.numeric}>
                    <DeltaCell value={deltaValue} flashToken={row.flashToken} />
                  </td>
                ) : null}
                <td className={styles.numeric}>
                  <span className={fiveHourCapTone}>
                    {formatContributionCapPercent(row.fiveHourCapUsedRatio, row.provider)}
                  </span>
                </td>
                <td className={styles.numeric}>{formatTimeOnly(row.fiveHourResetsAt)}</td>
                <td className={styles.numeric}>
                  <span className={sevenDayCapTone}>
                    {formatContributionCapPercent(row.sevenDayCapUsedRatio, row.provider)}
                  </span>
                </td>
                <td className={styles.numeric}>{formatShortTimestamp(row.sevenDayResetsAt)}</td>
                {/* Re-enable the hidden token-health cells when we bring the Util 24h / Maxed 7d headers back. */}
                {/* <td className={styles.numeric}>{formatPercent(row.utilizationRate24h)}</td>
                <td className={styles.numeric}>{formatCount(row.maxedEvents7d)}</td> */}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function BuyerTable({
  rows,
  hiddenIds,
  metric,
  sort,
  onSort,
}: {
  rows: AnalyticsBuyerRow[];
  hiddenIds: string[];
  metric: AnalyticsMetric;
  sort: SortState<BuyerSortKey>;
  onSort: (key: BuyerSortKey, defaultDirection: SortDirection) => void;
}) {
  const metricConfig = buyerMetricConfig(metric);

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
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
                label="Pref"
                onClick={() => onSort('effectiveProvider', 'asc')}
              />
            </th>
            {metricConfig.showShare ? (
              <th className={styles.numeric} aria-sort={sortAria(sort.key === 'percentOfWindow', sort.direction)}>
                <SortHeaderButton
                  active={sort.key === 'percentOfWindow'}
                  direction={sort.direction}
                  label="Share"
                  numeric
                  onClick={() => onSort('percentOfWindow', 'desc')}
                />
              </th>
            ) : null}
            <th className={styles.numeric} aria-sort={sortAria(sort.key === metricConfig.key, sort.direction)}>
              <SortHeaderButton
                active={sort.key === metricConfig.key}
                direction={sort.direction}
                label={metricConfig.label}
                numeric
                onClick={() => onSort(metricConfig.key, 'desc')}
              />
            </th>
            {metricConfig.showDelta ? <th className={styles.numeric}>Delta</th> : null}
            <th className={styles.numeric}>Last Seen</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const deltaValue = metricConfig.deltaValue(row);
            return (
            <tr
              key={row.apiKeyId}
              className={[
                hiddenIds.includes(row.apiKeyId) ? styles.rowHidden : '',
                metricConfig.showDelta && deltaValue > 0 ? styles.rowDeltaFlash : '',
              ].filter(Boolean).join(' ')}
            >
              <td>
                <div className={styles.identityCell}>
                  <span className={styles.identityPrimary}>{buyerIdentityLabel(row)}</span>
                  {row.label ? <span className={styles.identitySecondary}>{row.displayKey}</span> : null}
                </div>
              </td>
              <td>
                <div className={styles.identityCell}>
                  <span className={styles.identityPrimary} title={buyerOrgLabel(row)}>{buyerOrgLabel(row)}</span>
                  {row.orgLabel && row.orgId !== row.orgLabel ? (
                    <span className={styles.identitySecondary} title={row.orgId}>{buyerOrgIdLabel(row)}</span>
                  ) : null}
                </div>
              </td>
              <td>{buyerPreferenceLabel(row)}</td>
              {metricConfig.showShare ? <td className={styles.numeric}>{formatPercent(row.percentOfWindow)}</td> : null}
              <td className={styles.numeric}>{metricConfig.value(row)}</td>
              {metricConfig.showDelta ? (
                <td className={styles.numeric}>
                  <DeltaCell value={deltaValue} flashToken={row.flashToken} />
                </td>
              ) : null}
              <td className={styles.numeric}>{formatShortTimestamp(row.lastSeenAt)}</td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
