import { describe, expect, it } from 'vitest';
import {
  EARNINGS_BALANCE_BUCKETS,
  EARNINGS_EFFECT_TYPES,
  FINALIZATION_KINDS,
  PROJECTOR_STATES,
  PROJECTORS,
  ROUTING_MODES,
  WALLET_EFFECT_TYPES,
  WITHDRAWAL_REQUEST_STATUSES,
  buildEarningsProjectionEffects,
  buildWalletProjectionEffects,
  canTransitionWithdrawalRequestStatus
} from '../src/services/metering/ledgerProjectionContracts.js';

describe('phase2 shared contracts', () => {
  it('exports the locked finalization, routing, and projector value sets', () => {
    expect(FINALIZATION_KINDS).toEqual([
      'served_request',
      'correction',
      'reversal'
    ]);

    expect(ROUTING_MODES).toEqual([
      'self-free',
      'paid-team-capacity',
      'team-overflow-on-contributor-capacity'
    ]);

    expect(PROJECTORS).toEqual(['wallet', 'earnings']);
    expect(PROJECTOR_STATES).toEqual([
      'pending_projection',
      'projected',
      'needs_operator_correction'
    ]);
  });

  it('exports the locked wallet, earnings, and withdrawal value sets', () => {
    expect(WALLET_EFFECT_TYPES).toEqual([
      'buyer_debit',
      'buyer_correction',
      'buyer_reversal',
      'manual_credit',
      'manual_debit',
      'payment_credit',
      'payment_reversal'
    ]);

    expect(EARNINGS_EFFECT_TYPES).toEqual([
      'contributor_accrual',
      'contributor_correction',
      'contributor_reversal',
      'withdrawal_reserve',
      'withdrawal_release',
      'payout_settlement',
      'payout_adjustment'
    ]);

    expect(EARNINGS_BALANCE_BUCKETS).toEqual([
      'pending',
      'withdrawable',
      'reserved_for_payout',
      'settled',
      'adjusted'
    ]);

    expect(WITHDRAWAL_REQUEST_STATUSES).toEqual([
      'requested',
      'under_review',
      'approved',
      'rejected',
      'settlement_failed',
      'settled'
    ]);
  });

  it('allows only the locked withdrawal request transitions', () => {
    expect(canTransitionWithdrawalRequestStatus('requested', 'under_review')).toBe(true);
    expect(canTransitionWithdrawalRequestStatus('under_review', 'approved')).toBe(true);
    expect(canTransitionWithdrawalRequestStatus('under_review', 'rejected')).toBe(true);
    expect(canTransitionWithdrawalRequestStatus('approved', 'settled')).toBe(true);
    expect(canTransitionWithdrawalRequestStatus('approved', 'settlement_failed')).toBe(true);
    expect(canTransitionWithdrawalRequestStatus('settlement_failed', 'approved')).toBe(true);
    expect(canTransitionWithdrawalRequestStatus('settlement_failed', 'rejected')).toBe(true);

    expect(canTransitionWithdrawalRequestStatus('requested', 'approved')).toBe(false);
    expect(canTransitionWithdrawalRequestStatus('settled', 'approved')).toBe(false);
    expect(canTransitionWithdrawalRequestStatus('rejected', 'under_review')).toBe(false);
  });

  it('builds the expected wallet projection effects from canonical metering', () => {
    const served = buildWalletProjectionEffects({
      meteringEventId: 'me_1',
      finalizationKind: 'served_request',
      buyerDebitMinor: 250,
      contributorEarningsMinor: 0
    });
    const correction = buildWalletProjectionEffects({
      meteringEventId: 'me_2',
      finalizationKind: 'correction',
      buyerDebitMinor: -40,
      contributorEarningsMinor: 0
    });
    const reversal = buildWalletProjectionEffects({
      meteringEventId: 'me_3',
      finalizationKind: 'reversal',
      buyerDebitMinor: -250,
      contributorEarningsMinor: 0
    });
    const selfFree = buildWalletProjectionEffects({
      meteringEventId: 'me_4',
      finalizationKind: 'served_request',
      buyerDebitMinor: 0,
      contributorEarningsMinor: 0
    });

    expect(served).toEqual([
      {
        meteringEventId: 'me_1',
        effectType: 'buyer_debit',
        amountMinor: 250
      }
    ]);
    expect(correction).toEqual([
      {
        meteringEventId: 'me_2',
        effectType: 'buyer_correction',
        amountMinor: -40
      }
    ]);
    expect(reversal).toEqual([
      {
        meteringEventId: 'me_3',
        effectType: 'buyer_reversal',
        amountMinor: -250
      }
    ]);
    expect(selfFree).toEqual([]);
  });

  it('builds the expected earnings projection effects from canonical metering', () => {
    const served = buildEarningsProjectionEffects({
      meteringEventId: 'me_10',
      finalizationKind: 'served_request',
      buyerDebitMinor: 0,
      contributorEarningsMinor: 180
    });
    const correction = buildEarningsProjectionEffects({
      meteringEventId: 'me_11',
      finalizationKind: 'correction',
      buyerDebitMinor: 0,
      contributorEarningsMinor: -25
    });
    const reversal = buildEarningsProjectionEffects({
      meteringEventId: 'me_12',
      finalizationKind: 'reversal',
      buyerDebitMinor: 0,
      contributorEarningsMinor: -180
    });
    const zero = buildEarningsProjectionEffects({
      meteringEventId: 'me_13',
      finalizationKind: 'served_request',
      buyerDebitMinor: 0,
      contributorEarningsMinor: 0
    });

    expect(served).toEqual([
      {
        meteringEventId: 'me_10',
        effectType: 'contributor_accrual',
        amountMinor: 180
      }
    ]);
    expect(correction).toEqual([
      {
        meteringEventId: 'me_11',
        effectType: 'contributor_correction',
        amountMinor: -25
      }
    ]);
    expect(reversal).toEqual([
      {
        meteringEventId: 'me_12',
        effectType: 'contributor_reversal',
        amountMinor: -180
      }
    ]);
    expect(zero).toEqual([]);
  });
});
