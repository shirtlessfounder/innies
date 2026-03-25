import { describe, expect, it } from 'vitest';
import {
  OrgAccessRepository,
  type OrgAuthResolution
} from '../src/repos/orgAccessRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

describe('OrgAccessRepository', () => {
  it('creates an org and owner membership with persisted buyer role', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 1 });
    const repo = new OrgAccessRepository(db);

    await repo.createOrgWithOwner({
      orgId: 'org_1',
      orgName: 'Launch Team',
      orgSlug: 'launch-team',
      ownerUserId: 'user_owner',
      ownerMembershipId: 'membership_owner'
    });

    expect(db.queries[0]?.sql).toContain('insert into in_orgs');
    expect(db.queries[0]?.sql).toContain('owner_user_id');
    expect(db.queries[0]?.params).toEqual(['org_1', 'Launch Team', 'launch-team', 'user_owner']);
    expect(db.queries[1]?.sql).toContain('insert into in_memberships');
    expect(db.queries[1]?.sql).toContain('ended_at');
    expect(db.queries[1]?.params).toEqual([
      'membership_owner',
      'org_1',
      'user_owner',
      'buyer'
    ]);
  });

  it('normalizes github logins before persistence', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 1 });
    const repo = new OrgAccessRepository(db);

    await repo.upsertGithubLogin('user_1', '  ShirtlessFounder  ');

    expect(db.queries[0]?.sql).toContain('update in_users');
    expect(db.queries[0]?.params).toEqual(['user_1', 'shirtlessfounder']);
  });

  it('lists and finds orgs by slug', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{ id: 'org_1', slug: 'launch-team', name: 'Launch Team', owner_user_id: 'user_owner' }],
        rowCount: 1
      },
      {
        rows: [{ id: 'org_1', slug: 'launch-team', name: 'Launch Team', owner_user_id: 'user_owner' }],
        rowCount: 1
      }
    ]);
    const repo = new OrgAccessRepository(db);

    expect(await repo.listOrgs()).toEqual([{
      id: 'org_1',
      slug: 'launch-team',
      name: 'Launch Team',
      ownerUserId: 'user_owner'
    }]);
    expect(await repo.findOrgBySlug('launch-team')).toEqual({
      id: 'org_1',
      slug: 'launch-team',
      name: 'Launch Team',
      ownerUserId: 'user_owner'
    });
  });

  it('finds the active org for a user via active memberships only', async () => {
    const db = new MockSqlClient({
      rows: [{
        id: 'org_1',
        slug: 'launch-team',
        name: 'Launch Team',
        owner_user_id: 'user_owner'
      }],
      rowCount: 1
    });
    const repo = new OrgAccessRepository(db);

    await expect(repo.findActiveOrgByUserId('user_owner')).resolves.toEqual({
      id: 'org_1',
      slug: 'launch-team',
      name: 'Launch Team',
      ownerUserId: 'user_owner'
    });
    expect(db.queries[0]?.sql).toContain('membership.ended_at is null');
    expect(db.queries[0]?.params).toEqual(['user_owner']);
  });

  it('lists every active org membership for a user ordered by slug', async () => {
    const db = new MockSqlClient({
      rows: [
        {
          org_id: 'org_1',
          org_slug: 'acme',
          org_name: 'Acme',
          membership_id: 'membership_1',
          is_owner: true
        },
        {
          org_id: 'org_2',
          org_slug: 'beta',
          org_name: 'Beta',
          membership_id: 'membership_2',
          is_owner: false
        }
      ],
      rowCount: 2
    });
    const repo = new OrgAccessRepository(db);

    expect(await repo.listActiveOrgsForUser('user_1')).toEqual([
      {
        orgId: 'org_1',
        orgSlug: 'acme',
        orgName: 'Acme',
        membershipId: 'membership_1',
        isOwner: true
      },
      {
        orgId: 'org_2',
        orgSlug: 'beta',
        orgName: 'Beta',
        membershipId: 'membership_2',
        isOwner: false
      }
    ]);
    expect(db.queries[0]?.sql).toContain('membership.user_id = $1');
    expect(db.queries[0]?.sql).toContain('membership.ended_at is null');
    expect(db.queries[0]?.params).toEqual(['user_1']);
  });

  it('resolves active membership auth by org slug and normalized github login', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{ id: 'org_1', slug: 'launch-team', name: 'Launch Team', owner_user_id: 'user_owner' }],
        rowCount: 1
      },
      {
        rows: [{
          org_id: 'org_1',
          org_slug: 'launch-team',
          org_name: 'Launch Team',
          user_id: 'user_owner',
          membership_id: 'membership_owner',
          is_owner: true
        }],
        rowCount: 1
      }
    ]);
    const repo = new OrgAccessRepository(db);

    const resolution = await repo.findAuthResolutionBySlugAndGithubLogin({
      orgSlug: 'launch-team',
      githubLogin: '  ShirtlessFounder '
    });

    expect(resolution).toEqual<OrgAuthResolution>({
      kind: 'active_membership',
      orgId: 'org_1',
      orgSlug: 'launch-team',
      orgName: 'Launch Team',
      userId: 'user_owner',
      membershipId: 'membership_owner',
      isOwner: true
    });
    expect(db.queries[1]?.params).toEqual(['launch-team', 'shirtlessfounder']);
  });

  it('resolves pending invite and no-access states distinctly', async () => {
    const pendingDb = new SequenceSqlClient([
      {
        rows: [{ id: 'org_1', slug: 'launch-team', name: 'Launch Team', owner_user_id: 'user_owner' }],
        rowCount: 1
      },
      { rows: [], rowCount: 0 },
      {
        rows: [{ invite_id: 'invite_1', org_id: 'org_1', org_slug: 'launch-team', org_name: 'Launch Team' }],
        rowCount: 1
      }
    ]);
    const pendingRepo = new OrgAccessRepository(pendingDb);

    expect(await pendingRepo.findAuthResolutionBySlugAndGithubLogin({
      orgSlug: 'launch-team',
      githubLogin: 'InvitedUser'
    })).toEqual({
      kind: 'pending_invite',
      orgId: 'org_1',
      orgSlug: 'launch-team',
      orgName: 'Launch Team',
      inviteId: 'invite_1'
    });

    const noAccessDb = new SequenceSqlClient([
      {
        rows: [{ id: 'org_1', slug: 'launch-team', name: 'Launch Team', owner_user_id: 'user_owner' }],
        rowCount: 1
      },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 }
    ]);
    const noAccessRepo = new OrgAccessRepository(noAccessDb);

    expect(await noAccessRepo.findAuthResolutionBySlugAndGithubLogin({
      orgSlug: 'launch-team',
      githubLogin: 'outsider'
    })).toEqual({
      kind: 'no_access',
      orgId: 'org_1',
      orgSlug: 'launch-team',
      orgName: 'Launch Team'
    });
  });

  it('reactivates an ended membership without creating a second row', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{ id: 'membership_1', ended_at: '2026-03-20T00:00:00Z' }],
        rowCount: 1
      },
      {
        rows: [{ id: 'membership_1' }],
        rowCount: 1
      }
    ]);
    const repo = new OrgAccessRepository(db);

    expect(await repo.activateMembership({
      orgId: 'org_1',
      userId: 'user_1',
      membershipId: 'membership_new'
    })).toEqual({
      membershipId: 'membership_1',
      reactivated: true
    });
    expect(db.queries[1]?.sql).toContain('update in_memberships');
    expect(db.queries[1]?.sql).toContain('ended_at = null');
  });

  it('lists active members with owner flags', async () => {
    const db = new MockSqlClient({
      rows: [{
        user_id: 'user_owner',
        github_login: 'shirtlessfounder',
        membership_id: 'membership_owner',
        is_owner: true
      }],
      rowCount: 1
    });
    const repo = new OrgAccessRepository(db);

    expect(await repo.listMembers('org_1')).toEqual([{
      userId: 'user_owner',
      githubLogin: 'shirtlessfounder',
      membershipId: 'membership_owner',
      isOwner: true
    }]);
    expect(db.queries[0]?.sql).toContain('membership.ended_at is null');
  });
});
