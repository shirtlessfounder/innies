import { describe, expect, it } from 'vitest';
import { PilotCutoverFreezeRepository } from '../src/repos/pilotCutoverFreezeRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

describe('PilotCutoverFreezeRepository', () => {
  it('creates a freeze row and companion token-credential rows in one transaction', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{
          id: 'freeze_1',
          operation_kind: 'cutover',
          buyer_key_id: 'buyer_1',
          source_org_id: 'org_innies',
          target_org_id: 'org_fnf',
          source_cutover_id: null,
          created_by_user_id: 'user_admin',
          frozen_at: '2026-03-20T12:00:00Z',
          released_at: null,
          release_reason: null
        }],
        rowCount: 1
      },
      { rows: [], rowCount: 2 }
    ]);
    const repo = new PilotCutoverFreezeRepository(db, () => 'freeze_1');

    const row = await repo.createFreeze({
      operationKind: 'cutover',
      buyerKeyId: 'buyer_1',
      tokenCredentialIds: ['cred_1', 'cred_2'],
      sourceOrgId: 'org_innies',
      targetOrgId: 'org_fnf',
      createdByUserId: 'user_admin'
    });

    expect(row.id).toBe('freeze_1');
    expect(db.queries[0].sql).toContain('insert into in_pilot_cutover_freezes');
    expect(db.queries[1].sql).toContain('insert into in_pilot_cutover_freeze_credentials');
    expect(db.queries[1].params).toContain('cred_1');
    expect(db.queries[1].params).toContain('cred_2');
  });

  it('finds an active freeze by buyer key', async () => {
    const db = new MockSqlClient({
      rows: [{ id: 'freeze_1', operation_kind: 'rollback', buyer_key_id: 'buyer_1' }],
      rowCount: 1
    });
    const repo = new PilotCutoverFreezeRepository(db);

    await repo.findActiveByBuyerKeyId('buyer_1');

    expect(db.queries[0].sql).toContain('from in_pilot_cutover_freezes');
    expect(db.queries[0].sql).toContain('released_at is null');
    expect(db.queries[0].params).toContain('buyer_1');
  });

  it('finds an active freeze by token credential through the join table', async () => {
    const db = new MockSqlClient({
      rows: [{ id: 'freeze_1', operation_kind: 'cutover', buyer_key_id: 'buyer_1' }],
      rowCount: 1
    });
    const repo = new PilotCutoverFreezeRepository(db);

    await repo.findActiveByTokenCredentialId('cred_1');

    expect(db.queries[0].sql).toContain('join in_pilot_cutover_freeze_credentials');
    expect(db.queries[0].params).toContain('cred_1');
  });

  it('releases a freeze with an explicit reason', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 1 });
    const repo = new PilotCutoverFreezeRepository(db);

    const changed = await repo.releaseFreeze({
      freezeId: 'freeze_1',
      releaseReason: 'cutover_committed'
    });

    expect(changed).toBe(true);
    expect(db.queries[0].sql).toContain('update in_pilot_cutover_freezes');
    expect(db.queries[0].params).toContain('cutover_committed');
  });
});
