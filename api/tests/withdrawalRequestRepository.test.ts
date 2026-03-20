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

  it('writes api-key attribution for admin review transitions', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{ id: 'withdraw_3a', status: 'under_review' }],
        rowCount: 1
      },
      {
        rows: [{ id: 'withdraw_3a', status: 'approved', reviewed_by_api_key_id: 'key_admin_1' }],
        rowCount: 1
      }
    ]);
    const repo = new WithdrawalRequestRepository(db, () => 'withdraw_3a');

    const row = await repo.transitionStatus({
      id: 'withdraw_3a',
      nextStatus: 'approved',
      actedByUserId: null,
      actedByApiKeyId: 'key_admin_1'
    });

    expect(row).toEqual(expect.objectContaining({ id: 'withdraw_3a' }));
    expect(db.queries[1].sql).toContain('reviewed_by_api_key_id = $5');
    expect(db.queries[1].params).toContain('key_admin_1');
  });

  it('lists withdrawals by owner org for admin review queues', async () => {
    const db = new SequenceSqlClient([{
      rows: [{ id: 'withdraw_4', owner_org_id: 'org_fnf' }],
      rowCount: 1
    }]);
    const repo = new WithdrawalRequestRepository(db, () => 'withdraw_4');

    const rows = await repo.listByOwnerOrgId('org_fnf');

    expect(rows).toEqual([expect.objectContaining({ id: 'withdraw_4' })]);
    expect(db.queries[0].sql).toContain('where owner_org_id = $1');
  });

  it('lists withdrawals scoped to owner org and contributor user for pilot views', async () => {
    const db = new SequenceSqlClient([{
      rows: [{ id: 'withdraw_5', owner_org_id: 'org_fnf', contributor_user_id: 'user_darryn' }],
      rowCount: 1
    }]);
    const repo = new WithdrawalRequestRepository(db, () => 'withdraw_5');

    const rows = await repo.listByOwnerOrgAndContributorUserId({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn'
    });

    expect(rows).toEqual([expect.objectContaining({ id: 'withdraw_5' })]);
    expect(db.queries[0].sql).toContain('where owner_org_id = $1');
    expect(db.queries[0].sql).toContain('and contributor_user_id = $2');
  });
});
