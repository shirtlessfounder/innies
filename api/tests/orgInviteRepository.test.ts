import { describe, expect, it } from 'vitest';
import {
  OrgInviteRepository,
  AlreadyActiveOrgMemberError
} from '../src/repos/orgInviteRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

describe('OrgInviteRepository', () => {
  it('creates a fresh pending invite with normalized github login', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [{ id: 'invite_1' }], rowCount: 1 }
    ]);
    const repo = new OrgInviteRepository(db);

    expect(await repo.createOrRefreshPendingInvite({
      inviteId: 'invite_1',
      orgId: 'org_1',
      githubLogin: '  InvitedUser ',
      createdByUserId: 'user_owner'
    })).toEqual({
      inviteId: 'invite_1',
      createdFresh: true
    });
    expect(db.queries[0]?.params).toEqual(['org_1', 'inviteduser']);
    expect(db.queries[2]?.sql).toContain('insert into in_org_invites');
  });

  it('refreshes an existing pending invite instead of inserting another active row', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      {
        rows: [{ id: 'invite_existing' }],
        rowCount: 1
      },
      {
        rows: [{ id: 'invite_existing' }],
        rowCount: 1
      }
    ]);
    const repo = new OrgInviteRepository(db);

    expect(await repo.createOrRefreshPendingInvite({
      inviteId: 'invite_new',
      orgId: 'org_1',
      githubLogin: 'InvitedUser',
      createdByUserId: 'user_owner'
    })).toEqual({
      inviteId: 'invite_existing',
      createdFresh: false
    });
    expect(db.queries[2]?.sql).toContain('update in_org_invites');
    expect(db.queries[2]?.sql).toContain("status = 'pending'");
  });

  it('rejects invite creation for an already-active member', async () => {
    const db = new SequenceSqlClient([
      { rows: [{ membership_id: 'membership_1' }], rowCount: 1 }
    ]);
    const repo = new OrgInviteRepository(db);

    await expect(repo.createOrRefreshPendingInvite({
      inviteId: 'invite_1',
      orgId: 'org_1',
      githubLogin: 'shirtlessfounder',
      createdByUserId: 'user_owner'
    })).rejects.toBeInstanceOf(AlreadyActiveOrgMemberError);
  });

  it('lists pending invites with creator attribution and marks invites accepted or revoked', async () => {
    const listDb = new MockSqlClient({
      rows: [{
        invite_id: 'invite_1',
        github_login: 'inviteduser',
        created_at: '2026-03-24T00:00:00Z',
        created_by_user_id: 'user_owner'
      }],
      rowCount: 1
    });
    const listRepo = new OrgInviteRepository(listDb);

    expect(await listRepo.listPendingByOrg('org_1')).toEqual([{
      inviteId: 'invite_1',
      githubLogin: 'inviteduser',
      createdAt: '2026-03-24T00:00:00Z',
      createdByUserId: 'user_owner'
    }]);

    const mutationDb = new MockSqlClient({ rows: [], rowCount: 1 });
    const mutationRepo = new OrgInviteRepository(mutationDb);
    await mutationRepo.markAccepted({
      inviteId: 'invite_1',
      acceptedByUserId: 'user_member'
    });
    await mutationRepo.markRevoked({
      inviteId: 'invite_1',
      revokedByUserId: 'user_owner'
    });

    expect(mutationDb.queries[0]?.sql).toContain("status = 'accepted'");
    expect(mutationDb.queries[1]?.sql).toContain("status = 'revoked'");
  });
});
