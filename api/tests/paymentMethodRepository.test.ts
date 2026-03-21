import { describe, expect, it } from 'vitest';
import { PaymentMethodRepository } from '../src/repos/paymentMethodRepository.js';
import { MockSqlClient } from './testHelpers.js';

describe('PaymentMethodRepository', () => {
  it('only selects active default payment methods', async () => {
    const db = new MockSqlClient({
      rows: [],
      rowCount: 0
    });
    const repo = new PaymentMethodRepository(db);

    await repo.findDefaultByWalletId('wallet_1');

    expect(db.queries[0].sql).toContain("method.status = 'active'");
  });
});
