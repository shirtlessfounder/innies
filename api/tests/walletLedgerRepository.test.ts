import { describe, expect, it } from 'vitest';
import { WalletLedgerRepository } from '../src/repos/walletLedgerRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

describe('WalletLedgerRepository', () => {
  it('appends metering-derived wallet effects with idempotent metering keys', async () => {
    const db = new MockSqlClient({
      rows: [{ id: 'wallet_entry_1', effect_type: 'buyer_debit' }],
      rowCount: 1
    });
    const repo = new WalletLedgerRepository(db, () => 'wallet_entry_1');

    const row = await repo.appendEntry({
      walletId: 'wallet_1',
      ownerOrgId: 'org_fnf',
      buyerKeyId: 'buyer_1',
      meteringEventId: 'meter_1',
      effectType: 'buyer_debit',
      amountMinor: 450,
      currency: 'USD'
    });

    expect(row.id).toBe('wallet_entry_1');
    expect(db.queries[0].sql).toContain('insert into in_wallet_ledger');
    expect(db.queries[0].sql).toContain('on conflict');
    expect(db.queries[0].params).toContain('wallet_1');
    expect(db.queries[0].params).toContain('meter_1');
    expect(db.queries[0].params).toContain('buyer_debit');
    expect(db.queries[0].params).toContain(450);
  });

  it('requires reason metadata for manual wallet actions', async () => {
    const db = new MockSqlClient();
    const repo = new WalletLedgerRepository(db, () => 'wallet_entry_2');

    await expect(repo.appendEntry({
      walletId: 'wallet_1',
      ownerOrgId: 'org_fnf',
      effectType: 'manual_credit',
      amountMinor: 1000
    })).rejects.toThrow('manual wallet entries require actor metadata and reason');
  });

  it('accepts processor effect ids for payment-backed wallet rows without manual actor metadata', async () => {
    const db = new MockSqlClient({
      rows: [{ id: 'wallet_entry_3', effect_type: 'payment_credit' }],
      rowCount: 1
    });
    const repo = new WalletLedgerRepository(db, () => 'wallet_entry_3');

    await repo.appendEntry({
      walletId: 'wallet_1',
      ownerOrgId: 'org_fnf',
      effectType: 'payment_credit',
      amountMinor: 2500,
      processorEffectId: 'processor_evt_1',
      metadata: { trigger: 'post_finalization_negative' }
    });

    expect(db.queries[0].params).toContain('payment_credit');
    expect(db.queries[0].params).toContain('processor_evt_1');
  });

  it('returns the existing metering-derived row on duplicate projection keys', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      {
        rows: [{
          id: 'wallet_entry_existing',
          wallet_id: 'wallet_1',
          owner_org_id: 'org_fnf',
          buyer_key_id: 'buyer_1',
          metering_event_id: 'meter_1',
          effect_type: 'buyer_debit',
          amount_minor: 450,
          currency: 'USD',
          actor_user_id: null,
          reason: null,
          processor_effect_id: null,
          metadata: null,
          created_at: '2026-03-20T03:00:00Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new WalletLedgerRepository(db, () => 'wallet_entry_new');

    const row = await repo.appendEntry({
      walletId: 'wallet_1',
      ownerOrgId: 'org_fnf',
      buyerKeyId: 'buyer_1',
      meteringEventId: 'meter_1',
      effectType: 'buyer_debit',
      amountMinor: 450
    });

    expect(row.id).toBe('wallet_entry_existing');
    expect(db.queries).toHaveLength(2);
    expect(db.queries[1].sql).toContain('where metering_event_id = $1');
  });

  it('rejects duplicate wallet projection keys when the stored payload differs', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      {
        rows: [{
          id: 'wallet_entry_existing',
          wallet_id: 'wallet_1',
          owner_org_id: 'org_fnf',
          buyer_key_id: 'buyer_1',
          metering_event_id: 'meter_1',
          effect_type: 'buyer_debit',
          amount_minor: 999,
          currency: 'USD',
          actor_user_id: null,
          reason: null,
          processor_effect_id: null,
          metadata: null,
          created_at: '2026-03-20T03:00:00Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new WalletLedgerRepository(db, () => 'wallet_entry_new');

    await expect(repo.appendEntry({
      walletId: 'wallet_1',
      ownerOrgId: 'org_fnf',
      buyerKeyId: 'buyer_1',
      meteringEventId: 'meter_1',
      effectType: 'buyer_debit',
      amountMinor: 450
    })).rejects.toThrow('wallet ledger idempotent replay mismatch');
  });

  it('returns the existing manual row on duplicate deterministic entry ids', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      {
        rows: [{
          id: 'wallet_entry_manual',
          wallet_id: 'wallet_1',
          owner_org_id: 'org_fnf',
          buyer_key_id: null,
          metering_event_id: null,
          effect_type: 'manual_credit',
          amount_minor: 5000,
          currency: 'USD',
          actor_user_id: null,
          reason: 'usdc top-up',
          processor_effect_id: null,
          metadata: { actorApiKeyId: 'admin_key_1', source: 'admin_console' },
          created_at: '2026-03-20T03:00:00Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new WalletLedgerRepository(db, () => 'wallet_entry_new');

    const row = await repo.appendEntry({
      entryId: 'wallet_entry_manual',
      walletId: 'wallet_1',
      ownerOrgId: 'org_fnf',
      actorApiKeyId: 'admin_key_1',
      effectType: 'manual_credit',
      amountMinor: 5000,
      reason: 'usdc top-up',
      metadata: {
        source: 'admin_console'
      }
    });

    expect(row.id).toBe('wallet_entry_manual');
    expect(db.queries[1].sql).toContain('where id = $1');
  });

  it('computes wallet balance from append-only ledger effects', async () => {
    const db = new MockSqlClient({
      rows: [{
        wallet_id: 'wallet_1',
        balance_minor: 725
      }],
      rowCount: 1
    });
    const repo = new WalletLedgerRepository(db, () => 'wallet_entry_balance');

    const snapshot = await repo.readBalance('wallet_1');

    expect(snapshot).toEqual({
      walletId: 'wallet_1',
      balanceMinor: 725
    });
    expect(db.queries[0].sql).toContain('sum(');
    expect(db.queries[0].sql).toContain('from in_wallet_ledger');
    expect(db.queries[0].params).toEqual(['wallet_1']);
  });

  it('lists wallet history pages in reverse chronological order', async () => {
    const db = new MockSqlClient({
      rows: [{
        id: 'wallet_entry_9',
        wallet_id: 'wallet_1',
        owner_org_id: 'org_fnf',
        buyer_key_id: 'buyer_1',
        metering_event_id: 'meter_9',
        effect_type: 'buyer_debit',
        amount_minor: 450,
        currency: 'USD',
        actor_user_id: null,
        reason: null,
        processor_effect_id: null,
        metadata: null,
        created_at: '2026-03-20T03:00:00Z'
      }],
      rowCount: 1
    });
    const repo = new WalletLedgerRepository(db, () => 'wallet_entry_page');

    const rows = await repo.listPageByWalletId({
      walletId: 'wallet_1',
      limit: 10,
      cursor: {
        createdAt: '2026-03-20T04:00:00Z',
        id: 'wallet_entry_10'
      }
    });

    expect(rows).toHaveLength(1);
    expect(db.queries[0].sql).toContain('order by created_at desc, id desc');
    expect(db.queries[0].params).toEqual([
      'wallet_1',
      '2026-03-20T04:00:00Z',
      'wallet_entry_10',
      10
    ]);
  });
});
