import { describe, expect, it } from 'vitest';
import { PilotAdmissionFreezeRepository } from '../src/repos/pilotAdmissionFreezeRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

describe('PilotAdmissionFreezeRepository', () => {
  it('upserts active buyer-key freezes', async () => {
    const db = new MockSqlClient({
      rows: [{ resource_type: 'buyer_key', resource_id: 'buyer_1', released_at: null }],
      rowCount: 1
    });
    const repo = new PilotAdmissionFreezeRepository(db, () => 'freeze_1');

    await repo.activateFreeze({
      resourceType: 'buyer_key',
      resourceId: 'buyer_1',
      operationKind: 'cutover',
      sourceOrgId: 'org_innies',
      targetOrgId: 'org_fnf',
      actorUserId: 'user_admin'
    });

    expect(db.queries[0].sql).toContain('insert into in_pilot_admission_freezes');
    expect(db.queries[0].sql).toContain('on conflict (resource_type, resource_id)');
    expect(db.queries[0].params).toContain('buyer_key');
    expect(db.queries[0].params).toContain('buyer_1');
    expect(db.queries[0].params).toContain('cutover');
  });

  it('releases active freezes with actor and reason metadata', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 1 });
    const repo = new PilotAdmissionFreezeRepository(db);

    const released = await repo.releaseFreeze({
      resourceType: 'token_credential',
      resourceId: 'cred_1',
      releasedByUserId: 'user_admin',
      releaseReason: 'cutover_committed'
    });

    expect(released).toBe(true);
    expect(db.queries[0].sql).toContain('update in_pilot_admission_freezes');
    expect(db.queries[0].sql).toContain('set');
    expect(db.queries[0].sql).toContain('released_at = now()');
    expect(db.queries[0].params).toContain('token_credential');
    expect(db.queries[0].params).toContain('cred_1');
    expect(db.queries[0].params).toContain('cutover_committed');
  });

  it('reads an active freeze for a resource', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{
          id: 'freeze_1',
          resource_type: 'buyer_key',
          resource_id: 'buyer_1',
          operation_kind: 'rollback',
          source_org_id: 'org_fnf',
          target_org_id: 'org_innies',
          actor_user_id: 'user_admin',
          released_at: null,
          release_reason: null,
          released_by_user_id: null,
          last_error: 'reserve floor migration failed',
          created_at: '2026-03-20T00:00:00Z',
          updated_at: '2026-03-20T00:00:00Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new PilotAdmissionFreezeRepository(db);

    const row = await repo.findActiveFreeze('buyer_key', 'buyer_1');

    expect(row?.id).toBe('freeze_1');
    expect(db.queries[0].sql).toContain('where resource_type = $1');
    expect(db.queries[0].sql).toContain('and resource_id = $2');
    expect(db.queries[0].sql).toContain('and released_at is null');
  });

  it('records failure details without releasing the freeze', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 1 });
    const repo = new PilotAdmissionFreezeRepository(db);

    const updated = await repo.recordFailure({
      resourceType: 'buyer_key',
      resourceId: 'buyer_1',
      errorMessage: 'reserve floor migration failed'
    });

    expect(updated).toBe(true);
    expect(db.queries[0].sql).toContain('update in_pilot_admission_freezes');
    expect(db.queries[0].sql).toContain('set last_error = $3');
    expect(db.queries[0].sql).toContain('and released_at is null');
  });
});
