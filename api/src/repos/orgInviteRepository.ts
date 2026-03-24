import type { SqlClient } from './sqlClient.js';

export class AlreadyActiveOrgMemberError extends Error {
  constructor(orgId: string, githubLogin: string) {
    super(`User ${githubLogin} is already an active member of org ${orgId}`);
    this.name = 'AlreadyActiveOrgMemberError';
  }
}

function normalizeGithubLogin(login: string): string {
  return login.trim().toLowerCase();
}

export class OrgInviteRepository {
  constructor(private readonly db: SqlClient) {}

  async createOrRefreshPendingInvite(input: {
    inviteId: string;
    orgId: string;
    githubLogin: string;
    createdByUserId: string;
  }): Promise<{ inviteId: string; createdFresh: boolean }> {
    const normalized = normalizeGithubLogin(input.githubLogin);

    const activeMember = await this.db.query<{ membership_id: string }>(
      `select membership.id as membership_id
      from in_memberships membership
      join in_users u on u.id = membership.user_id
      where membership.org_id = $1
        and u.github_login = $2
        and membership.ended_at is null
      limit 1`,
      [input.orgId, normalized]
    );

    if (activeMember.rowCount > 0) {
      throw new AlreadyActiveOrgMemberError(input.orgId, normalized);
    }

    const existingInvite = await this.db.query<{ id: string }>(
      `select id from in_org_invites
      where org_id = $1
        and github_login = $2
        and status = 'pending'
      limit 1`,
      [input.orgId, normalized]
    );

    if (existingInvite.rowCount === 1) {
      const existingId = existingInvite.rows[0].id;
      await this.db.query(
        `update in_org_invites
        set status = 'pending', updated_at = now(), created_by_user_id = $2
        where id = $1`,
        [existingId, input.createdByUserId]
      );
      return { inviteId: existingId, createdFresh: false };
    }

    await this.db.query(
      `insert into in_org_invites (id, org_id, github_login, created_by_user_id, status, created_at, updated_at)
      values ($1, $2, $3, $4, 'pending', now(), now())`,
      [input.inviteId, input.orgId, normalized, input.createdByUserId]
    );
    return { inviteId: input.inviteId, createdFresh: true };
  }

  async listPendingByOrg(orgId: string): Promise<Array<{
    inviteId: string;
    githubLogin: string;
    createdAt: string;
    createdByUserId: string;
  }>> {
    const result = await this.db.query<{
      invite_id: string;
      github_login: string;
      created_at: string;
      created_by_user_id: string;
    }>(
      `select
        id as invite_id,
        github_login,
        created_at,
        created_by_user_id
      from in_org_invites
      where org_id = $1
        and status = 'pending'
      order by created_at asc`,
      [orgId]
    );
    return result.rows.map((row) => ({
      inviteId: row.invite_id,
      githubLogin: row.github_login,
      createdAt: row.created_at,
      createdByUserId: row.created_by_user_id
    }));
  }

  async markAccepted(input: {
    inviteId: string;
    acceptedByUserId: string;
  }): Promise<void> {
    await this.db.query(
      `update in_org_invites
      set status = 'accepted', accepted_at = now(), accepted_by_user_id = $2, updated_at = now()
      where id = $1`,
      [input.inviteId, input.acceptedByUserId]
    );
  }

  async markRevoked(input: {
    inviteId: string;
    revokedByUserId: string;
  }): Promise<void> {
    await this.db.query(
      `update in_org_invites
      set status = 'revoked', revoked_at = now(), revoked_by_user_id = $2, updated_at = now()
      where id = $1`,
      [input.inviteId, input.revokedByUserId]
    );
  }
}
