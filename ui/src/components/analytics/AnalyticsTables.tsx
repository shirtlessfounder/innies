'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

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

export type TokenRowRemoveConfig = {
  orgSlug: string;
  viewerGithubLogin: string | null;
  createdByGithubLoginByTokenId: Record<string, string | null>;
};

function readErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim().length > 0) {
      return record.message;
    }
    if (typeof record.code === 'string' && record.code.trim().length > 0) {
      return record.code;
    }
    if (typeof record.kind === 'string' && record.kind.trim().length > 0) {
      return record.kind;
    }
  }
  return fallback;
}

async function safeReadBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function canRemoveTokenRow(row: AnalyticsTokenRow, tokenRowRemoveConfig: TokenRowRemoveConfig): boolean {
  const tokenCreatorLogin = tokenRowRemoveConfig.createdByGithubLoginByTokenId[row.credentialId] ?? null;
  const canRemove = tokenCreatorLogin !== null && tokenCreatorLogin === tokenRowRemoveConfig.viewerGithubLogin;
  return canRemove;
}

function buildRemoveTokenPath(row: AnalyticsTokenRow, tokenRowRemoveConfig: TokenRowRemoveConfig): string {
  return `/api/orgs/${tokenRowRemoveConfig.orgSlug}/tokens/${row.credentialId}/remove`;
}

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

function tokenStatusTone(row: AnalyticsTokenRow): string {
  const compactStatus = row.compactStatus.trim().toLowerCase();
  const rawStatus = row.rawStatus.trim().toLowerCase();
  if (compactStatus === 'active*' || row.exclusionReason !== null) {
    return styles.statusPillRateLimited;
  }
  if (compactStatus === 'maxed' || compactStatus === 'benched') {
    return styles.statusPillMaxed;
  }
  switch (rawStatus) {
    case 'active':
      return styles.statusPillActive;
    case 'paused':
      return styles.statusPillPaused;
    case 'rotating':
      return styles.statusPillRotating;
    case 'expired':
      return styles.statusPillExpired;
    case 'revoked':
      return styles.statusPillRevoked;
    default:
      return styles.statusPillUnknown;
  }
}

function TokenStatusCell(input: {
  row: AnalyticsTokenRow;
  expanded: boolean;
}) {
  const label = input.expanded ? input.row.expandedStatus : input.row.compactStatus;
  return (
    <span
      className={[
        styles.statusPill,
        tokenStatusTone(input.row),
        input.expanded ? styles.statusPillExpanded : '',
      ].filter(Boolean).join(' ')}
    >
      {label}
    </span>
  );
}

function statusHeaderGlyph(input: {
  expanded: boolean;
  pinned: boolean;
}): string {
  if (input.pinned) return '[]';
  if (input.expanded) return '<>';
  return '..';
}

function statusColumnClassName(input: {
  expanded: boolean;
}): string {
  return [
    styles.statusColumn,
    input.expanded ? styles.statusColumnExpanded : styles.statusColumnCompact,
  ].join(' ');
}

function contributionCapTone(input: {
  provider: string;
  utilizationRatio: number | null;
  exhausted: boolean | null;
}): string {
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
  tokenRowRemoveConfig,
}: {
  rows: AnalyticsTokenRow[];
  hiddenIds: string[];
  metric: AnalyticsMetric;
  sort: SortState<TokenSortKey>;
  onSort: (key: TokenSortKey, defaultDirection: SortDirection) => void;
  tokenRowRemoveConfig?: TokenRowRemoveConfig;
}) {
  const router = useRouter();
  const metricConfig = tokenMetricConfig(metric);
  const [statusHovered, setStatusHovered] = useState(false);
  const [statusPinned, setStatusPinned] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [pendingRemoveTokenId, setPendingRemoveTokenId] = useState<string | null>(null);
  const statusExpanded = statusPinned || statusHovered;
  const statusColumnClass = statusColumnClassName({ expanded: statusExpanded });

  async function handleRemoveToken(row: AnalyticsTokenRow) {
    if (!tokenRowRemoveConfig || pendingRemoveTokenId) return;

    setPendingRemoveTokenId(row.credentialId);
    setRemoveError(null);

    try {
      const response = await fetch(buildRemoveTokenPath(row, tokenRowRemoveConfig), {
        method: 'POST',
      });
      const body = await safeReadBody(response);
      if (!response.ok) {
        setRemoveError(readErrorMessage(body, 'Could not remove this token.'));
        return;
      }

      router.refresh();
    } catch (submitError) {
      setRemoveError(submitError instanceof Error ? submitError.message : 'Could not remove this token.');
    } finally {
      setPendingRemoveTokenId(null);
    }
  }

  return (
    <>
      {removeError ? (
        <div className={styles.noticeList}>
          <div className={styles.noticeError}>{removeError}</div>
        </div>
      ) : null}
      <div className={styles.tableWrap}>
        <table className={[styles.table, statusExpanded ? styles.tableStatusExpanded : ''].filter(Boolean).join(' ')}>
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
            <th
              aria-sort="none"
              className={statusColumnClass}
              onMouseEnter={() => setStatusHovered(true)}
              onMouseLeave={() => setStatusHovered(false)}
            >
              <button
                className={[
                  styles.sortButton,
                  styles.statusHeaderButton,
                  statusPinned ? styles.statusHeaderButtonPinned : '',
                ].filter(Boolean).join(' ')}
                type="button"
                aria-pressed={statusPinned}
                onClick={() => setStatusPinned((current) => !current)}
              >
                <span>Status</span>
                <span className={statusPinned || statusExpanded ? styles.sortGlyphActive : styles.sortGlyph}>
                  {statusHeaderGlyph({ expanded: statusExpanded, pinned: statusPinned })}
                </span>
              </button>
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
            {tokenRowRemoveConfig ? <th className={styles.numeric}>REMOVE</th> : null}
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
            const canRemove = tokenRowRemoveConfig
              ? canRemoveTokenRow(row, tokenRowRemoveConfig)
              : false;

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
                <td
                  className={statusColumnClass}
                  onMouseEnter={() => setStatusHovered(true)}
                  onMouseLeave={() => setStatusHovered(false)}
                >
                  <TokenStatusCell
                    row={row}
                    expanded={statusExpanded}
                  />
                </td>
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
                {tokenRowRemoveConfig ? (
                  <td className={styles.numeric}>
                    {canRemove ? (
                        <button
                          className={styles.managementTableActionButton}
                          disabled={pendingRemoveTokenId === row.credentialId}
                          onClick={() => handleRemoveToken(row)}
                          type="button"
                        >
                        {pendingRemoveTokenId === row.credentialId ? '[removing]' : '[remove]'}
                      </button>
                    ) : '--'}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
        </table>
      </div>
    </>
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
