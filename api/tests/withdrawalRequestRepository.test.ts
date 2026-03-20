import { describe, expect, it } from 'vitest';
import { WithdrawalRequestRepository } from '../src/repos/withdrawalRequestRepository.js';
import { SequenceSqlClient } from './testHelpers.js';

describe('WithdrawalRequestRepository', () => {
  it('creates requested withdrawal rows with destination and actor metadata', async () => {
    const db = new SequenceSqlClient([{
      rows: [{ id: 'withdraw_1', status: 'requested' }],
      rowCount: 1
    }]);
    const repo = new WithdrawalRequestRepository(db, () => 'withdraw_1');

    const row = await repo.create({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn',
      amountMinor: 750,
      currency: 'USD',
      destination: { rail: 'manual_usdc', address: '0xabc' },
      requestedByUserId: 'user_darryn',
      note: 'pilot withdrawal'
    });

    expect(row.id).toBe('withdraw_1');
    expect(db.queries[0].sql).toContain('insert into in_withdrawal_requests');
    expect(db.queries[0].params).toContain('requested');
  });

  it('rejects illegal withdrawal status transitions', async () => {
    const db = new SequenceSqlClient([{
      rows: [{ id: 'withdraw_2', status: 'requested' }],
      rowCount: 1
    }]);
    const repo = new WithdrawalRequestRepository(db, () => 'withdraw_2');

    await expect(repo.transitionStatus({
      id: 'withdraw_2',
      nextStatus: 'approved',
      actedByUserId: 'admin_1'
    })).rejects.toThrow('illegal withdrawal request transition: requested -> approved');
  });

  it('detects concurrent withdrawal transitions with compare-and-swap writes', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{ id: 'withdraw_3', status: 'under_review' }],
        rowCount: 1
      },
      {
        rows: [],
        rowCount: 0
      }
    ]);
    const repo = new WithdrawalRequestRepository(db, () => 'withdraw_3');

    await expect(repo.transitionStatus({
      id: 'withdraw_3',
      nextStatus: 'approved',
      actedByUserId: 'admin_1'
    })).rejects.toThrow('withdrawal request transitioned concurrently: withdraw_3');

    expect(db.queries[1].sql).toContain('and status = $2');
  });
});
