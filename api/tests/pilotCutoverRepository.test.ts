import { describe, expect, it } from 'vitest';
import { PilotCutoverRepository } from '../src/repos/pilotCutoverRepository.js';
import { MockSqlClient } from './testHelpers.js';

describe('PilotCutoverRepository', () => {
  it('creates committed cutover rows with shared completion markers', async () => {
    const db = new MockSqlClient({
      rows: [{ id: 'cut_1', effective_at: '2026-03-20T00:00:00Z' }],
      rowCount: 1
    });
    const repo = new PilotCutoverRepository(db, () => 'cut_1');

    const row = await repo.createCutoverRecord({
      sourceOrgId: 'org_innies',
      targetOrgId: 'org_fnf',
      effectiveAt: new Date('2026-03-20T00:00:00Z'),
      buyerKeyOwnershipSwapped: true,
      providerCredentialOwnershipSwapped: true,
      reserveFloorMigrationCompleted: true,
      createdByUserId: 'admin_1'
    });

    expect(row.id).toBe('cut_1');
    expect(db.queries[0].sql).toContain('insert into in_cutover_records');
    expect(db.queries[0].params).toContain(true);
    expect(db.queries[0].params).toContain('org_fnf');
  });

  it('creates rollback rows with reverted ownership targets', async () => {
    const db = new MockSqlClient({
      rows: [{ id: 'rollback_1', effective_at: '2026-03-20T01:00:00Z' }],
      rowCount: 1
    });
    const repo = new PilotCutoverRepository(db, () => 'rollback_1');

    const row = await repo.createRollbackRecord({
      sourceCutoverId: 'cut_1',
      effectiveAt: new Date('2026-03-20T01:00:00Z'),
      revertedBuyerKeyTargetOrgId: 'org_innies',
      revertedProviderCredentialTargetOrgId: 'org_innies',
      createdByUserId: 'admin_1'
    });

    expect(row.id).toBe('rollback_1');
    expect(db.queries[0].sql).toContain('insert into in_rollback_records');
    expect(db.queries[0].params).toContain('cut_1');
    expect(db.queries[0].params).toContain('org_innies');
  });

  it('reads only committed cutover markers', async () => {
    const db = new MockSqlClient({
      rows: [],
      rowCount: 0
    });
    const repo = new PilotCutoverRepository(db);

    const row = await repo.getLatestCommittedCutover();

    expect(row).toBeNull();
    expect(db.queries[0].sql).toContain('where buyer_key_ownership_swapped = true');
    expect(db.queries[0].sql).toContain('and provider_credential_ownership_swapped = true');
    expect(db.queries[0].sql).toContain('and reserve_floor_migration_completed = true');
  });
});
