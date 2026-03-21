import { describe, expect, it } from 'vitest';
import { PilotIdentityRepository } from '../src/repos/pilotIdentityRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

describe('PilotIdentityRepository', () => {
  it('creates the fnf org when the slug does not exist', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      {
        rows: [{ id: 'org_fnf', slug: 'fnf', name: 'Friends & Family' }],
        rowCount: 1
      }
    ]);
    const repo = new PilotIdentityRepository(db, () => 'generated_1');

    const row = await repo.ensureOrg({
      slug: 'fnf',
      name: 'Friends & Family'
    });

    expect(row.id).toBe('org_fnf');
    expect(db.queries[0].sql).toContain('from in_orgs');
    expect(db.queries[1].sql).toContain('insert into in_orgs');
    expect(db.queries[1].params).toContain('fnf');
  });

  it('creates the target user when the email does not exist', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      {
        rows: [{ id: 'user_darryn', email: 'darryn@example.com', display_name: 'Darryn' }],
        rowCount: 1
      }
    ]);
    const repo = new PilotIdentityRepository(db, () => 'generated_2');

    const row = await repo.ensureUser({
      email: 'darryn@example.com',
      displayName: 'Darryn'
    });

    expect(row.id).toBe('user_darryn');
    expect(db.queries[0].sql).toContain('from in_users');
    expect(db.queries[1].sql).toContain('insert into in_users');
    expect(db.queries[1].params).toContain('darryn@example.com');
  });

  it('ensures membership idempotently for the target org and user', async () => {
    const db = new MockSqlClient({
      rows: [{ id: 'membership_1', org_id: 'org_fnf', user_id: 'user_darryn', role: 'buyer' }],
      rowCount: 1
    });
    const repo = new PilotIdentityRepository(db, () => 'membership_1');

    const row = await repo.ensureMembership({
      orgId: 'org_fnf',
      userId: 'user_darryn',
      role: 'buyer'
    });

    expect(row.id).toBe('membership_1');
    expect(db.queries[0].sql).toContain('insert into in_memberships');
    expect(db.queries[0].sql).toContain('on conflict (org_id, user_id)');
    expect(db.queries[0].params).toContain('buyer');
  });

  it('reassigns buyer keys to the target org', async () => {
    const db = new MockSqlClient({
      rows: [{ id: 'buyer_1' }, { id: 'buyer_2' }],
      rowCount: 2
    });
    const repo = new PilotIdentityRepository(db);

    const updatedIds = await repo.reassignBuyerKeysToOrg({
      apiKeyIds: ['buyer_1', 'buyer_2'],
      targetOrgId: 'org_fnf'
    });

    expect(updatedIds).toEqual(['buyer_1', 'buyer_2']);
    expect(db.queries[0].sql).toContain('update in_api_keys');
    expect(db.queries[0].sql).toContain('where id = any($1::uuid[])');
    expect(db.queries[0].params?.[1]).toBe('org_fnf');
  });

  it('reassigns token credentials to the target org', async () => {
    const db = new MockSqlClient({
      rows: [{ id: 'cred_1' }],
      rowCount: 1
    });
    const repo = new PilotIdentityRepository(db);

    const updatedIds = await repo.reassignTokenCredentialsToOrg({
      tokenCredentialIds: ['cred_1'],
      targetOrgId: 'org_fnf'
    });

    expect(updatedIds).toEqual(['cred_1']);
    expect(db.queries[0].sql).toContain('update in_token_credentials');
    expect(db.queries[0].sql).toContain('where id = any($1::uuid[])');
    expect(db.queries[0].params?.[1]).toBe('org_fnf');
  });

  it('lists pilot identity discovery rows by org slug for admin impersonation', async () => {
    const db = new MockSqlClient({
      rows: [{
        org_id: 'org_fnf',
        org_slug: 'fnf',
        org_name: 'Friends & Family',
        user_id: 'user_darryn',
        user_email: 'darryn@example.com',
        display_name: 'Darryn'
      }],
      rowCount: 1
    });
    const repo = new PilotIdentityRepository(db);

    const rows = await (repo as any).listOrgUserDirectoryBySlug('fnf');

    expect(rows).toEqual([{
      orgId: 'org_fnf',
      orgSlug: 'fnf',
      orgName: 'Friends & Family',
      userId: 'user_darryn',
      userEmail: 'darryn@example.com',
      displayName: 'Darryn'
    }]);
    expect(db.queries[0].sql).toContain('from in_orgs org');
    expect(db.queries[0].sql).toContain('join in_memberships membership');
    expect(db.queries[0].sql).toContain('join in_users "user"');
    expect(db.queries[0].sql).toContain('where org.slug = $1');
    expect(db.queries[0].params).toEqual(['fnf']);
  });
});
