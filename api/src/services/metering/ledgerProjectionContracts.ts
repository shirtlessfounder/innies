import {
  EARNINGS_BALANCE_BUCKETS,
  EARNINGS_EFFECT_TYPES,
  FINALIZATION_KINDS,
  PROJECTORS,
  PROJECTOR_STATES,
  ROUTING_MODES,
  WALLET_EFFECT_TYPES,
  WITHDRAWAL_REQUEST_STATUSES,
  canTransitionWithdrawalRequestStatus,
  type CanonicalMeteringProjectionContract,
  type EarningsProjectionEffectDraft,
  type WalletProjectionEffectDraft
} from '../../types/phase2Contracts.js';

export {
  EARNINGS_BALANCE_BUCKETS,
  EARNINGS_EFFECT_TYPES,
  FINALIZATION_KINDS,
  PROJECTORS,
  PROJECTOR_STATES,
  ROUTING_MODES,
  WALLET_EFFECT_TYPES,
  WITHDRAWAL_REQUEST_STATUSES,
  canTransitionWithdrawalRequestStatus
};

export function buildWalletProjectionEffects(
  input: CanonicalMeteringProjectionContract
): WalletProjectionEffectDraft[] {
  if (input.buyerDebitMinor === 0) {
    return [];
  }

  return [{
    meteringEventId: input.meteringEventId,
    effectType: walletEffectTypeFor(input.finalizationKind),
    amountMinor: input.buyerDebitMinor
  }];
}

export function buildEarningsProjectionEffects(
  input: CanonicalMeteringProjectionContract
): EarningsProjectionEffectDraft[] {
  if (input.contributorEarningsMinor === 0) {
    return [];
  }

  return [{
    meteringEventId: input.meteringEventId,
    effectType: earningsEffectTypeFor(input.finalizationKind),
    amountMinor: input.contributorEarningsMinor
  }];
}

function walletEffectTypeFor(
  finalizationKind: CanonicalMeteringProjectionContract['finalizationKind']
): WalletProjectionEffectDraft['effectType'] {
  switch (finalizationKind) {
    case 'served_request':
      return 'buyer_debit';
    case 'correction':
      return 'buyer_correction';
    case 'reversal':
      return 'buyer_reversal';
  }
}

function earningsEffectTypeFor(
  finalizationKind: CanonicalMeteringProjectionContract['finalizationKind']
): EarningsProjectionEffectDraft['effectType'] {
  switch (finalizationKind) {
    case 'served_request':
      return 'contributor_accrual';
    case 'correction':
      return 'contributor_correction';
    case 'reversal':
      return 'contributor_reversal';
  }
}
