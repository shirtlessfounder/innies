export const FINALIZATION_KINDS = [
  'served_request',
  'correction',
  'reversal'
] as const;

export type FinalizationKind = typeof FINALIZATION_KINDS[number];

export const ROUTING_MODES = [
  'self-free',
  'paid-team-capacity',
  'team-overflow-on-contributor-capacity'
] as const;

export type RoutingMode = typeof ROUTING_MODES[number];

export const WALLET_EFFECT_TYPES = [
  'buyer_debit',
  'buyer_correction',
  'buyer_reversal',
  'manual_credit',
  'manual_debit',
  'payment_credit',
  'payment_reversal'
] as const;

export type WalletEffectType = typeof WALLET_EFFECT_TYPES[number];

export const EARNINGS_EFFECT_TYPES = [
  'contributor_accrual',
  'contributor_correction',
  'contributor_reversal',
  'withdrawal_reserve',
  'withdrawal_release',
  'payout_settlement',
  'payout_adjustment'
] as const;

export type EarningsEffectType = typeof EARNINGS_EFFECT_TYPES[number];

export const PROJECTORS = ['wallet', 'earnings'] as const;

export type Projector = typeof PROJECTORS[number];

export const PROJECTOR_STATES = [
  'pending_projection',
  'projected',
  'needs_operator_correction'
] as const;

export type ProjectorState = typeof PROJECTOR_STATES[number];

export const EARNINGS_BALANCE_BUCKETS = [
  'pending',
  'withdrawable',
  'reserved_for_payout',
  'settled',
  'adjusted'
] as const;

export type EarningsBalanceBucket = typeof EARNINGS_BALANCE_BUCKETS[number];

export const WITHDRAWAL_REQUEST_STATUSES = [
  'requested',
  'under_review',
  'approved',
  'rejected',
  'settlement_failed',
  'settled'
] as const;

export type WithdrawalRequestStatus = typeof WITHDRAWAL_REQUEST_STATUSES[number];

export const WITHDRAWAL_REQUEST_STATUS_TRANSITIONS: Readonly<Record<WithdrawalRequestStatus, readonly WithdrawalRequestStatus[]>> = {
  requested: ['under_review'],
  under_review: ['approved', 'rejected'],
  approved: ['settled', 'settlement_failed'],
  rejected: [],
  settlement_failed: ['approved', 'rejected'],
  settled: []
};

export type CanonicalMeteringProjectionContract = {
  meteringEventId: string;
  finalizationKind: FinalizationKind;
  buyerDebitMinor: number;
  contributorEarningsMinor: number;
};

export type WalletProjectionEffectDraft = {
  meteringEventId: string;
  effectType: Extract<WalletEffectType, 'buyer_debit' | 'buyer_correction' | 'buyer_reversal'>;
  amountMinor: number;
};

export type EarningsProjectionEffectDraft = {
  meteringEventId: string;
  effectType: Extract<EarningsEffectType, 'contributor_accrual' | 'contributor_correction' | 'contributor_reversal'>;
  amountMinor: number;
};

export function canTransitionWithdrawalRequestStatus(
  from: WithdrawalRequestStatus,
  to: WithdrawalRequestStatus
): boolean {
  return WITHDRAWAL_REQUEST_STATUS_TRANSITIONS[from].includes(to);
}
