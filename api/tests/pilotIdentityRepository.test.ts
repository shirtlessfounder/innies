import { describe, expect, it } from 'vitest';
import { PilotIdentityRepository } from '../src/repos/pilotIdentityRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

describe('PilotIdentityRepository', () => {
  it('ensures the fnf org by slug', async () => {
    const db = new MockSqlClient({
      rows: [{ id: 'org_fnf', slug: 'fnf', name: 'Friends & Family' }],
      rowCount: 1
    });
    const repo = new PilotIdentityRepository(db, () => 'org_fnf');

    const row = await repo.ensureOrg({
      slug: 'fnf',
      name: 'Friends & Family'
    });

    expect(row.id).toBe('org_fnf');
    expect(db.queries[0].sql).toContain('insert into in_orgs');
    expect(db.queries[0].sql).toContain('on conflict (slug)');
    expect(db.queries[0].params).toContain('Friends & Family');
  });

  it('creates a user when email is not already present', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      {
        rows: [{ id: 'user_darryn', email: 'darryn@example.com', display_name: 'Darryn' }],
        rowCount: 1
      }
    ]);
    const repo = new PilotIdentityRepository(db, () => 'user_darryn');

    const row = await repo.ensureUser({
      email: 'darryn@example.com',
      displayName: 'Darryn'
    });

    expect(row.id).toBe('user_darryn');
    expect(db.queries[0].sql).toContain('from in_users');
    expect(db.queries[1].sql).toContain('insert into in_users');
    expect(db.queries[1].params).toContain('darryn@example.com');
  });

  it('upserts a GitHub identity by user id', async () => {
    const db = new MockSqlClient({
      rows: [{ user_id: 'user_darryn', github_login: 'darryn' }],
      rowCount: 1
    });
    const repo = new PilotIdentityRepository(db);

    await repo.upsertGithubIdentity({
      userId: 'user_darryn',
      githubUserId: '12345',
      githubLogin: 'darryn',
      githubEmail: 'darryn@example.com'
    });

    expect(db.queries[0].sql).toContain('insert into in_github_identities');
    expect(db.queries[0].sql).toContain('on conflict (user_id)');
    expect(db.queries[0].params).toContain('12345');
    expect(db.queries[0].params).toContain('darryn');
  });

  it('finds a GitHub identity by login', async () => {
    const db = new MockSqlClient({
      rows: [{ user_id: 'user_darryn', github_login: 'darryn', github_user_id: '12345' }],
      rowCount: 1
    });
    const repo = new PilotIdentityRepository(db);

    const row = await repo.findGithubIdentityByLogin('Darryn');

    expect(row?.user_id).toBe('user_darryn');
    expect(db.queries[0].sql).toContain('from in_github_identities');
    expect(db.queries[0].sql).toContain('where lower(github_login) = lower($1)');
    expect(db.queries[0].params).toContain('Darryn');
  });

  it('ensures memberships without duplicating an existing org-user pair', async () => {
    const db = new MockSqlClient({
      rows: [{ id: 'membership_1', org_id: 'org_fnf', user_id: 'user_darryn', role: 'buyer' }],
      rowCount: 1
    });
    const repo = new PilotIdentityRepository(db, () => 'membership_1');

    await repo.ensureMembership({
      orgId: 'org_fnf',
      userId: 'user_darryn',
      role: 'buyer'
    });

    expect(db.queries[0].sql).toContain('insert into in_memberships');
    expect(db.queries[0].sql).toContain('on conflict (org_id, user_id)');
    expect(db.queries[0].params).toContain('buyer');
  });

  it('finds a GitHub identity by login for impersonation lookups', async () => {
    const db = new MockSqlClient({
      rows: [{ user_id: 'user_darryn', github_user_id: '12345', github_login: 'darryn', github_email: 'darryn@example.com' }],
      rowCount: 1
    });
    const repo = new PilotIdentityRepository(db);

    const row = await repo.findGithubIdentityByLogin('darryn');

    expect(row?.user_id).toBe('user_darryn');
    expect(db.queries[0].sql).toContain('from in_github_identities');
    expect(db.queries[0].sql).toContain('lower(github_login) = lower($1)');
  });

  it('finds an org by slug for session context resolution', async () => {
    const db = new MockSqlClient({
      rows: [{ id: 'org_innies', slug: 'innies', name: 'Innies' }],
      rowCount: 1
    });
    const repo = new PilotIdentityRepository(db);

    const row = await repo.findOrgBySlug('innies');

    expect(row?.id).toBe('org_innies');
    expect(db.queries[0].sql).toContain('from in_orgs');
    expect(db.queries[0].params).toContain('innies');
  });
});
