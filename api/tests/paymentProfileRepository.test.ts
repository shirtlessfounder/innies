import { describe, expect, it } from 'vitest';
import { PaymentProfileRepository } from '../src/repos/paymentProfileRepository.js';
import { MockSqlClient } from './testHelpers.js';

describe('PaymentProfileRepository', () => {
  it('preserves the existing processor customer on wallet conflict', async () => {
    const db = new MockSqlClient({
      rows: [{
        id: 'payment_profile_1',
        wallet_id: 'wallet_1',
        owner_org_id: 'org_fnf',
        processor: 'stripe',
        processor_customer_id: 'cus_existing',
        default_payment_method_id: null,
        created_at: '2026-03-21T12:00:00.000Z',
        updated_at: '2026-03-21T12:00:00.000Z'
      }],
      rowCount: 1
    });
    const repo = new PaymentProfileRepository(db, () => 'payment_profile_1');

    await repo.ensureProfile({
      walletId: 'wallet_1',
      ownerOrgId: 'org_fnf',
      processorCustomerId: 'cus_new'
    });

    expect(db.queries[0].sql).not.toContain('processor_customer_id = excluded.processor_customer_id');
  });
});
