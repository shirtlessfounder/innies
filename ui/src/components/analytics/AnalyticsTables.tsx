'use client';

import { TbEye, TbEyeClosed } from 'react-icons/tb';
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
  buyerSeriesLabel,
  formatCount,
  formatNullableNumber,
  formatPercent,
  formatTimestamp,
  tokenIdentityLabel,
  tokenLabelLabel,
  tokenProviderLabel,
  tokenSeriesLabel,
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
    case 'rotating':
      return styles.statusPillRotating;
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
      {status}
    </span>
  );
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

function VisibilityToggleButton(input: {
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

export function TokenTable({
  rows,
  hiddenIds,
  metric,
  onToggle,
  sort,
  onSort,
}: {
  rows: AnalyticsTokenRow[];
  hiddenIds: string[];
  metric: AnalyticsMetric;
  onToggle: (id: string) => void;
  sort: SortState<TokenSortKey>;
  onSort: (key: TokenSortKey, defaultDirection: SortDirection) => void;
}) {
  const metricConfig = tokenMetricConfig(metric);

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Hide</th>
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
            <th className={styles.numeric} aria-sort={sortAria(sort.key === metricConfig.key, sort.direction)}>
              <SortHeaderButton
                active={sort.key === metricConfig.key}
                direction={sort.direction}
                label={metricConfig.label}
                numeric
                onClick={() => onSort(metricConfig.key, 'desc')}
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
            {metricConfig.showDelta ? <th className={styles.numeric}>Delta</th> : null}
            {/* Re-enable Util 24h / Maxed 7d once the token table has room for the extra operator-only columns again. */}
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
            return (
            <tr
              key={row.credentialId}
              className={[
                hiddenIds.includes(row.credentialId) ? styles.rowHidden : '',
                metricConfig.showDelta && deltaValue > 0 ? styles.rowDeltaFlash : '',
              ].filter(Boolean).join(' ')}
            >
              <td>
                <VisibilityToggleButton
                  hidden={hiddenIds.includes(row.credentialId)}
                  label={tokenSeriesLabel(row)}
                  onClick={() => onToggle(row.credentialId)}
                />
              </td>
              <td>{tokenIdentityLabel(row)}</td>
              <td>{tokenLabelLabel(row)}</td>
              <td>{tokenProviderLabel(row.provider)}</td>
              <td><TokenStatusCell status={row.status} /></td>
              <td className={styles.numeric}>{metricConfig.value(row)}</td>
              {metricConfig.showShare ? <td className={styles.numeric}>{formatPercent(row.percentOfWindow)}</td> : null}
              {metricConfig.showDelta ? (
                <td className={styles.numeric}>
                  <DeltaCell value={deltaValue} flashToken={row.flashToken} />
                </td>
              ) : null}
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
  onToggle,
  sort,
  onSort,
}: {
  rows: AnalyticsBuyerRow[];
  hiddenIds: string[];
  metric: AnalyticsMetric;
  onToggle: (id: string) => void;
  sort: SortState<BuyerSortKey>;
  onSort: (key: BuyerSortKey, defaultDirection: SortDirection) => void;
}) {
  const metricConfig = buyerMetricConfig(metric);

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Hide</th>
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
            <th className={styles.numeric} aria-sort={sortAria(sort.key === metricConfig.key, sort.direction)}>
              <SortHeaderButton
                active={sort.key === metricConfig.key}
                direction={sort.direction}
                label={metricConfig.label}
                numeric
                onClick={() => onSort(metricConfig.key, 'desc')}
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
            {metricConfig.showDelta ? <th className={styles.numeric}>Delta</th> : null}
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
                <VisibilityToggleButton
                  hidden={hiddenIds.includes(row.apiKeyId)}
                  label={buyerSeriesLabel(row)}
                  onClick={() => onToggle(row.apiKeyId)}
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
                  <span className={styles.identityPrimary} title={buyerOrgLabel(row)}>{buyerOrgLabel(row)}</span>
                  {row.orgLabel && row.orgId !== row.orgLabel ? (
                    <span className={styles.identitySecondary} title={row.orgId}>{buyerOrgIdLabel(row)}</span>
                  ) : null}
                </div>
              </td>
              <td>{buyerPreferenceLabel(row)}</td>
              <td className={styles.numeric}>{metricConfig.value(row)}</td>
              {metricConfig.showShare ? <td className={styles.numeric}>{formatPercent(row.percentOfWindow)}</td> : null}
              {metricConfig.showDelta ? (
                <td className={styles.numeric}>
                  <DeltaCell value={deltaValue} flashToken={row.flashToken} />
                </td>
              ) : null}
              <td>{formatTimestamp(row.lastSeenAt)}</td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
