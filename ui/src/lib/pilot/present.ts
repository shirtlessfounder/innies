import type {
  ConnectedAccount,
  RequestHistoryRow,
  WalletLedgerEntry,
  Withdrawal,
} from './types';

const moneyFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numberFormat = new Intl.NumberFormat('en-US');
const percentFormat = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

export function formatUsdMinor(amountMinor: number | null | undefined): string {
  if (amountMinor === null || amountMinor === undefined) return '--';
  return moneyFormat.format(amountMinor / 100);
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--';
  return numberFormat.format(value);
}

export function formatPercentRatio(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--';
  return percentFormat.format(Math.max(0, Math.min(1, value)));
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '--';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(parsed));
}

export function formatProvider(value: string | null | undefined): string {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'anthropic') return 'Claude';
  if (normalized === 'codex') return 'Codex';
  if (normalized === 'openai') return 'OpenAI';
  return value?.trim() || '--';
}

export function formatRoutingMode(value: string | null | undefined): string {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'self-free':
      return 'Self free';
    case 'paid-team-capacity':
      return 'Paid team capacity';
    case 'team-overflow-on-contributor-capacity':
      return 'Team overflow on contributor capacity';
    default:
      return value?.trim() || '--';
  }
}

export function formatWalletEffectType(entry: WalletLedgerEntry): string {
  switch ((entry.effect_type ?? '').trim().toLowerCase()) {
    case 'manual_credit':
      return 'Manual top-up';
    case 'manual_debit':
      return 'Manual debit';
    case 'buyer_debit':
      return 'Request charge';
    case 'buyer_correction':
      return 'Charge correction';
    case 'buyer_reversal':
      return 'Charge reversal';
    case 'payment_credit':
      return 'Card top-up';
    case 'payment_reversal':
      return 'Payment reversal';
    default:
      return entry.effect_type || 'Ledger entry';
  }
}

export function formatProviderUsageWarning(account: ConnectedAccount): string {
  switch (account.providerUsageWarning) {
    case 'provider_usage_snapshot_missing':
      return 'Awaiting provider usage snapshot';
    case 'provider_usage_snapshot_soft_stale':
      return 'Provider usage snapshot is aging';
    case 'provider_usage_snapshot_hard_stale':
      return 'Provider usage snapshot is stale';
    case 'contribution_cap_exhausted_5h':
      return '5h reserve floor is exhausted';
    case 'contribution_cap_exhausted_7d':
      return '7d reserve floor is exhausted';
    case 'usage_exhausted_5h':
      return 'Provider 5h window is exhausted';
    case 'usage_exhausted_7d':
      return 'Provider 7d window is exhausted';
    default:
      return '--';
  }
}

export function summarizeRouteDecision(row: RequestHistoryRow): string {
  const reason = row.route_decision && typeof row.route_decision.reason === 'string'
    ? row.route_decision.reason
    : null;
  if (reason) return reason.replaceAll('_', ' ');
  return formatRoutingMode(row.admission_routing_mode);
}

export function formatWithdrawalDestination(withdrawal: Withdrawal): string {
  const destination = withdrawal.destination;
  if (!destination || typeof destination !== 'object') return '--';
  const rail = typeof destination.rail === 'string' ? destination.rail : null;
  const address = typeof destination.address === 'string' ? destination.address : null;
  return [rail, address].filter(Boolean).join(' · ') || '--';
}

export function formatAccountHealth(account: ConnectedAccount): string {
  const pieces = [
    account.expandedStatus,
    account.providerUsageWarning ? formatProviderUsageWarning(account) : null
  ].filter((value): value is string => Boolean(value) && value !== '--');
  return pieces.join(' · ') || '--';
}
