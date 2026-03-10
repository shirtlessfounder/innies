'use client';

import { TbEye, TbEyeClosed } from 'react-icons/tb';
import type {
  BuyerSortKey,
  SortDirection,
  SortState,
  TokenSortKey,
} from '../../lib/analytics/sort';
import { type AnalyticsBuyerRow, type AnalyticsTokenRow } from '../../lib/analytics/types';
import {
  buyerIdentityLabel,
  buyerOrgIdLabel,
  buyerOrgLabel,
  buyerPreferenceLabel,
  buyerSeriesLabel,
  formatCount,
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
  onToggle,
  sort,
  onSort,
}: {
  rows: AnalyticsTokenRow[];
  hiddenIds: string[];
  onToggle: (id: string) => void;
  sort: SortState<TokenSortKey>;
  onSort: (key: TokenSortKey, defaultDirection: SortDirection) => void;
}) {
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
                label="Label"
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
            <th className={styles.numeric} aria-sort={sortAria(sort.key === 'percentOfWindow', sort.direction)}>
              <SortHeaderButton
                active={sort.key === 'percentOfWindow'}
                direction={sort.direction}
                label="Share"
                numeric
                onClick={() => onSort('percentOfWindow', 'desc')}
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
            <tr
              key={row.credentialId}
              className={[
                hiddenIds.includes(row.credentialId) ? styles.rowHidden : '',
                row.deltaUsageUnits > 0 ? styles.rowDeltaFlash : '',
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
              <td className={styles.numeric}>{formatCount(row.attempts)}</td>
              <td className={styles.numeric}>{formatCount(row.usageUnits)}</td>
              <td className={styles.numeric}>{formatPercent(row.percentOfWindow)}</td>
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

export function BuyerTable({
  rows,
  hiddenIds,
  onToggle,
  sort,
  onSort,
}: {
  rows: AnalyticsBuyerRow[];
  hiddenIds: string[];
  onToggle: (id: string) => void;
  sort: SortState<BuyerSortKey>;
  onSort: (key: BuyerSortKey, defaultDirection: SortDirection) => void;
}) {
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
            <tr
              key={row.apiKeyId}
              className={[
                hiddenIds.includes(row.apiKeyId) ? styles.rowHidden : '',
                row.deltaUsageUnits > 0 ? styles.rowDeltaFlash : '',
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
