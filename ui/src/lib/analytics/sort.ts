import {
  buyerIdentityLabel,
  buyerOrgLabel,
  buyerPreferenceLabel,
  tokenIdentityLabel,
  tokenLabelLabel,
  tokenProviderLabel,
} from './present';
import type { AnalyticsBuyerRow, AnalyticsTokenRow } from './types';

export type SortDirection = 'asc' | 'desc';

export type TokenSortKey =
  | 'displayKey'
  | 'debugLabel'
  | 'provider'
  | 'status'
  | 'attempts'
  | 'usageUnits'
  | 'percentOfWindow'
  | 'utilizationRate24h'
  | 'maxedEvents7d';

export type BuyerSortKey =
  | 'label'
  | 'org'
  | 'effectiveProvider'
  | 'requests'
  | 'usageUnits'
  | 'percentOfWindow'
  | 'lastSeenAt';

export type SortState<Key extends string> = {
  key: Key;
  direction: SortDirection;
};

export const DEFAULT_TOKEN_SORT: SortState<TokenSortKey> = {
  key: 'usageUnits',
  direction: 'desc',
};

export const DEFAULT_BUYER_SORT: SortState<BuyerSortKey> = {
  key: 'usageUnits',
  direction: 'desc',
};

function compareNullableNumbers(left: number | null | undefined, right: number | null | undefined): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
  if (right === null || right === undefined) return -1;
  return left - right;
}

function compareNullableStrings(left: string | null | undefined, right: string | null | undefined): number {
  const leftValue = left?.trim();
  const rightValue = right?.trim();
  if (!leftValue) return !rightValue ? 0 : 1;
  if (!rightValue) return -1;
  return leftValue.localeCompare(rightValue, 'en', { numeric: true, sensitivity: 'base' });
}

function directionValue(direction: SortDirection, comparison: number): number {
  return direction === 'asc' ? comparison : comparison * -1;
}

function compareTokenRows(
  left: AnalyticsTokenRow,
  right: AnalyticsTokenRow,
  sort: SortState<TokenSortKey>,
): number {
  switch (sort.key) {
    case 'displayKey':
      return directionValue(sort.direction, compareNullableStrings(tokenIdentityLabel(left), tokenIdentityLabel(right)));
    case 'debugLabel':
      return directionValue(sort.direction, compareNullableStrings(tokenLabelLabel(left), tokenLabelLabel(right)));
    case 'provider':
      return directionValue(sort.direction, compareNullableStrings(tokenProviderLabel(left.provider), tokenProviderLabel(right.provider)));
    case 'status':
      return directionValue(sort.direction, compareNullableStrings(left.status, right.status));
    case 'attempts':
      return directionValue(sort.direction, compareNullableNumbers(left.attempts, right.attempts));
    case 'percentOfWindow':
      return directionValue(sort.direction, compareNullableNumbers(left.percentOfWindow, right.percentOfWindow));
    case 'utilizationRate24h':
      return directionValue(sort.direction, compareNullableNumbers(left.utilizationRate24h, right.utilizationRate24h));
    case 'maxedEvents7d':
      return directionValue(sort.direction, compareNullableNumbers(left.maxedEvents7d, right.maxedEvents7d));
    case 'usageUnits':
    default:
      return directionValue(sort.direction, compareNullableNumbers(left.usageUnits, right.usageUnits));
  }
}

function compareBuyerRows(
  left: AnalyticsBuyerRow,
  right: AnalyticsBuyerRow,
  sort: SortState<BuyerSortKey>,
): number {
  switch (sort.key) {
    case 'label':
      return directionValue(sort.direction, compareNullableStrings(buyerIdentityLabel(left), buyerIdentityLabel(right)));
    case 'org':
      return directionValue(sort.direction, compareNullableStrings(buyerOrgLabel(left), buyerOrgLabel(right)));
    case 'effectiveProvider':
      return directionValue(sort.direction, compareNullableStrings(buyerPreferenceLabel(left), buyerPreferenceLabel(right)));
    case 'requests':
      return directionValue(sort.direction, compareNullableNumbers(left.requests, right.requests));
    case 'percentOfWindow':
      return directionValue(sort.direction, compareNullableNumbers(left.percentOfWindow, right.percentOfWindow));
    case 'lastSeenAt':
      return directionValue(
        sort.direction,
        compareNullableNumbers(
          left.lastSeenAt ? Date.parse(left.lastSeenAt) : null,
          right.lastSeenAt ? Date.parse(right.lastSeenAt) : null,
        ),
      );
    case 'usageUnits':
    default:
      return directionValue(sort.direction, compareNullableNumbers(left.usageUnits, right.usageUnits));
  }
}

export function toggleSort<Key extends string>(
  current: SortState<Key>,
  key: Key,
  defaultDirection: SortDirection,
): SortState<Key> {
  if (current.key !== key) {
    return { key, direction: defaultDirection };
  }

  return {
    key,
    direction: current.direction === 'desc' ? 'asc' : 'desc',
  };
}

export function sortTokenRows(rows: AnalyticsTokenRow[], sort: SortState<TokenSortKey>): AnalyticsTokenRow[] {
  return [...rows].sort((left, right) => {
    const primary = compareTokenRows(left, right, sort);
    if (primary !== 0) return primary;
    return compareNullableStrings(tokenIdentityLabel(left), tokenIdentityLabel(right));
  });
}

export function sortBuyerRows(rows: AnalyticsBuyerRow[], sort: SortState<BuyerSortKey>): AnalyticsBuyerRow[] {
  return [...rows].sort((left, right) => {
    const primary = compareBuyerRows(left, right, sort);
    if (primary !== 0) return primary;
    return compareNullableStrings(left.displayKey, right.displayKey);
  });
}
