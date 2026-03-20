import { describe, expect, it } from 'vitest';
import { EarningsLedgerRepository } from '../src/repos/earningsLedgerRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

describe('EarningsLedgerRepository', () => {
  it('appends metering-derived earnings rows with balance-bucket truth', async () => {
    const db = new MockSqlClient({
      rows: [{ id: 'earnings_entry_1', effect_type: 'contributor_accrual' }],
      rowCount: 1
    });
    const repo = new EarningsLedgerRepository(db, () => 'earnings_entry_1');

    const row = await repo.appendEntry({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn',
      meteringEventId: 'meter_earnings_1',
      effectType: 'contributor_accrual',
      balanceBucket: 'pending',
      amountMinor: 180,
      currency: 'USD'
    });

    expect(row.id).toBe('earnings_entry_1');
    expect(db.queries[0].sql).toContain('insert into in_earnings_ledger');
    expect(db.queries[0].params).toContain('meter_earnings_1');
    expect(db.queries[0].params).toContain('contributor_accrual');
    expect(db.queries[0].params).toContain('pending');
  });

  it('requires reason metadata for non-metering earnings actions', async () => {
    const db = new MockSqlClient();
    const repo = new EarningsLedgerRepository(db, () => 'earnings_entry_2');

    await expect(repo.appendEntry({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn',
      effectType: 'payout_adjustment',
      balanceBucket: 'adjusted',
      amountMinor: -50
    })).rejects.toThrow('manual earnings entries require reason');
  });

  it('requires actor attribution for manual earnings actions', async () => {
    const db = new MockSqlClient();
    const repo = new EarningsLedgerRepository(db, () => 'earnings_entry_2a');

    await expect(repo.appendEntry({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn',
      effectType: 'payout_adjustment',
      balanceBucket: 'adjusted',
      amountMinor: -50,
      reason: 'network fee'
    })).rejects.toThrow('manual earnings entries require actor attribution');
  });

  it('writes api-key attribution for manual earnings actions', async () => {
    const db = new MockSqlClient({
      rows: [{ id: 'earnings_entry_2b', effect_type: 'payout_adjustment', actor_api_key_id: 'key_admin_1' }],
      rowCount: 1
    });
    const repo = new EarningsLedgerRepository(db, () => 'earnings_entry_2b');

    const row = await repo.appendEntry({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn',
      effectType: 'payout_adjustment',
      balanceBucket: 'adjusted',
      amountMinor: -50,
      actorApiKeyId: 'key_admin_1',
      reason: 'network fee'
    });

    expect(row).toEqual(expect.objectContaining({ id: 'earnings_entry_2b' }));
    expect(db.queries[0].sql).toContain('actor_api_key_id');
    expect(db.queries[0].params).toContain('key_admin_1');
  });

  it('lists earnings rows scoped to owner org and contributor user', async () => {
    const db = new MockSqlClient({
      rows: [{ id: 'earnings_entry_5', owner_org_id: 'org_fnf', contributor_user_id: 'user_darryn' }],
      rowCount: 1
    });
    const repo = new EarningsLedgerRepository(db, () => 'earnings_entry_5');

    const rows = await repo.listByOwnerOrgAndContributorUserId({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn'
    });

    expect(rows).toEqual([expect.objectContaining({ id: 'earnings_entry_5' })]);
    expect(db.queries[0].sql).toContain('where owner_org_id = $1');
    expect(db.queries[0].sql).toContain('and contributor_user_id = $2');
  });

  it('returns the existing metering-derived earnings row on duplicate projection keys', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      {
        rows: [{
          id: 'earnings_entry_existing',
          owner_org_id: 'org_fnf',
          contributor_user_id: 'user_darryn',
          metering_event_id: 'meter_earnings_1',
          effect_type: 'contributor_accrual',
          balance_bucket: 'pending',
          amount_minor: 180,
          currency: 'USD',
          actor_user_id: null,
          actor_api_key_id: null,
          reason: null,
          withdrawal_request_id: null,
          payout_reference: null,
          metadata: null,
          created_at: '2026-03-20T03:00:00Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new EarningsLedgerRepository(db, () => 'earnings_entry_new');

    const row = await repo.appendEntry({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn',
      meteringEventId: 'meter_earnings_1',
      effectType: 'contributor_accrual',
      balanceBucket: 'pending',
      amountMinor: 180
    });

    expect(row.id).toBe('earnings_entry_existing');
    expect(db.queries).toHaveLength(2);
    expect(db.queries[1].sql).toContain('where metering_event_id = $1');
  });

  it('rejects duplicate earnings projection keys when the stored payload differs', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      {
        rows: [{
          id: 'earnings_entry_existing',
          owner_org_id: 'org_fnf',
          contributor_user_id: 'user_darryn',
          metering_event_id: 'meter_earnings_1',
          effect_type: 'contributor_accrual',
          balance_bucket: 'withdrawable',
          amount_minor: 180,
          currency: 'USD',
          actor_user_id: null,
          actor_api_key_id: null,
          reason: null,
          withdrawal_request_id: null,
          payout_reference: null,
          metadata: null,
          created_at: '2026-03-20T03:00:00Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new EarningsLedgerRepository(db, () => 'earnings_entry_new');

    await expect(repo.appendEntry({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn',
      meteringEventId: 'meter_earnings_1',
      effectType: 'contributor_accrual',
      balanceBucket: 'pending',
      amountMinor: 180
    })).rejects.toThrow('earnings ledger idempotent replay mismatch');
  });
});
