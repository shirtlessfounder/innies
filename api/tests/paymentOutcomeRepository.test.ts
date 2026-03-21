import { describe, expect, it } from 'vitest';
import { PaymentOutcomeRepository } from '../src/repos/paymentOutcomeRepository.js';
import { SequenceSqlClient } from './testHelpers.js';

describe('PaymentOutcomeRepository', () => {
  it('accepts webhook reconciliation when only processor event metadata differs from a sync placeholder row', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      {
        rows: [{
          id: 'payment_outcome_existing',
          wallet_id: 'org_fnf',
          owner_org_id: 'org_fnf',
          payment_attempt_id: 'payment_attempt_1',
          processor: 'stripe',
          processor_event_id: 'sync:pi_1',
          processor_effect_id: 'stripe:payment_intent:pi_1',
          effect_type: 'payment_credit',
          amount_minor: 2500,
          currency: 'USD',
          metadata: {
            trigger: 'admission_blocked',
            source: 'sync_auto_recharge'
          },
          created_at: '2026-03-20T10:31:00.000Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new PaymentOutcomeRepository(db, () => 'payment_outcome_new');

    const row = await repo.upsertOutcome({
      walletId: 'org_fnf',
      ownerOrgId: 'org_fnf',
      paymentAttemptId: 'payment_attempt_1',
      processorEventId: 'evt_1',
      processorEffectId: 'stripe:payment_intent:pi_1',
      effectType: 'payment_credit',
      amountMinor: 2500,
      currency: 'USD',
      metadata: {
        eventType: 'payment_intent.succeeded'
      }
    });

    expect(row.id).toBe('payment_outcome_existing');
  });
});
