import type { SqlClient } from './sqlClient.js';

export type OrgAuthResolution =
  | { kind: 'active_membership'; orgId: string; orgSlug: string; orgName: string; userId: string; membershipId: string; isOwner: boolean }
  | { kind: 'pending_invite'; orgId: string; orgSlug: string; orgName: string; inviteId: string }
  | { kind: 'no_access'; orgId: string; orgSlug: string; orgName: string }
  | { kind: 'org_not_found' };

export type ActiveOrgMembership = {
  orgId: string;
  orgSlug: string;
  orgName: string;
  membershipId: string;
  isOwner: boolean;
};

type OrgRow = { id: string; slug: string; name: string; owner_user_id: string };
type OrgSummary = { id: string; slug: string; name: string; ownerUserId: string };

function normalizeGithubLogin(login: string): string {
  return login.trim().toLowerCase();
}

function mapOrg(row: OrgRow): OrgSummary {
  return { id: row.id, slug: row.slug, name: row.name, ownerUserId: row.owner_user_id };
}

export class OrgAccessRepository {
  constructor(private readonly db: SqlClient) {}

  async createOrgWithOwner(input: {
    orgId: string;
    orgName: string;
    orgSlug: string;
    ownerUserId: string;
    ownerMembershipId: string;
  }): Promise<void> {
    await this.db.query(
      `insert into in_orgs (id, name, slug, owner_user_id) values ($1, $2, $3, $4)`,
      [input.orgId, input.orgName, input.orgSlug, input.ownerUserId]
    );
    await this.db.query(
      `insert into in_memberships (id, org_id, user_id, role, ended_at, created_at) values ($1, $2, $3, $4, null, now())`,
      [input.ownerMembershipId, input.orgId, input.ownerUserId, 'buyer']
    );
  }

  async upsertGithubLogin(userId: string, githubLogin: string): Promise<void> {
    await this.db.query(
      `update in_users set github_login = $2 where id = $1`,
      [userId, normalizeGithubLogin(githubLogin)]
    );
  }

  async listOrgs(): Promise<OrgSummary[]> {
    const result = await this.db.query<OrgRow>(
      `select id, slug, name, owner_user_id from in_orgs order by name asc`
    );
    return result.rows.map(mapOrg);
  }

  async findOrgBySlug(slug: string): Promise<OrgSummary | null> {
    const result = await this.db.query<OrgRow>(
      `select id, slug, name, owner_user_id from in_orgs where slug = $1 limit 1`,
      [slug]
    );
    return result.rowCount === 1 ? mapOrg(result.rows[0]) : null;
  }

  async findActiveOrgByUserId(userId: string): Promise<OrgSummary | null> {
    const result = await this.db.query<OrgRow>(
      `select
        org.id,
        org.slug,
        org.name,
        org.owner_user_id
      from in_memberships membership
      join in_orgs org on org.id = membership.org_id
      where membership.user_id = $1
        and membership.ended_at is null
      order by (org.owner_user_id = membership.user_id) desc, membership.created_at asc
      limit 1`,
      [userId]
    );
    return result.rowCount === 1 ? mapOrg(result.rows[0]) : null;
  }

  async listActiveOrgsForUser(userId: string): Promise<ActiveOrgMembership[]> {
    const result = await this.db.query<{
      org_id: string;
      org_slug: string;
      org_name: string;
      membership_id: string;
      is_owner: boolean;
    }>(
      `select
        org.id as org_id,
        org.slug as org_slug,
        org.name as org_name,
        membership.id as membership_id,
        (org.owner_user_id = membership.user_id) as is_owner
      from in_memberships membership
      join in_orgs org on org.id = membership.org_id
      where membership.user_id = $1
        and membership.ended_at is null
      order by org.slug asc`,
      [userId]
    );

    return result.rows.map((row) => ({
      orgId: row.org_id,
      orgSlug: row.org_slug,
      orgName: row.org_name,
      membershipId: row.membership_id,
      isOwner: row.is_owner
    }));
  }

  async findAuthResolutionBySlugAndGithubLogin(input: {
    orgSlug: string;
    githubLogin: string;
  }): Promise<OrgAuthResolution> {
    const org = await this.findOrgBySlug(input.orgSlug);
    if (!org) return { kind: 'org_not_found' };

    const normalized = normalizeGithubLogin(input.githubLogin);

    const membership = await this.db.query<{
      org_id: string;
      org_slug: string;
      org_name: string;
      user_id: string;
      membership_id: string;
      is_owner: boolean;
    }>(
      `select
        membership.org_id as org_id,
        org.slug as org_slug,
        org.name as org_name,
        membership.user_id as user_id,
        membership.id as membership_id,
        (org.owner_user_id = membership.user_id) as is_owner
      from in_memberships membership
      join in_orgs org on org.id = membership.org_id
      join in_users u on u.id = membership.user_id
      where org.slug = $1
        and u.github_login = $2
        and membership.ended_at is null
      limit 1`,
      [input.orgSlug, normalized]
    );

    if (membership.rowCount === 1) {
      const row = membership.rows[0];
      return {
        kind: 'active_membership',
        orgId: row.org_id,
        orgSlug: row.org_slug,
        orgName: row.org_name,
        userId: row.user_id,
        membershipId: row.membership_id,
        isOwner: row.is_owner
      };
    }

    const invite = await this.db.query<{
      invite_id: string;
      org_id: string;
      org_slug: string;
      org_name: string;
    }>(
      `select
        inv.id as invite_id,
        inv.org_id as org_id,
        org.slug as org_slug,
        org.name as org_name
      from in_org_invites inv
      join in_orgs org on org.id = inv.org_id
      where org.slug = $1
        and inv.github_login = $2
        and inv.status = 'pending'
      limit 1`,
      [input.orgSlug, normalized]
    );

    if (invite.rowCount === 1) {
      const row = invite.rows[0];
      return {
        kind: 'pending_invite',
        orgId: row.org_id,
        orgSlug: row.org_slug,
        orgName: row.org_name,
        inviteId: row.invite_id
      };
    }

    return {
      kind: 'no_access',
      orgId: org.id,
      orgSlug: org.slug,
      orgName: org.name
    };
  }

  async activateMembership(input: {
    orgId: string;
    userId: string;
    membershipId: string;
  }): Promise<{ membershipId: string; reactivated: boolean }> {
    const existing = await this.db.query<{ id: string; ended_at: string | null }>(
      `select id, ended_at from in_memberships where org_id = $1 and user_id = $2 limit 1`,
      [input.orgId, input.userId]
    );

    if (existing.rowCount === 1) {
      const row = existing.rows[0];
      if (row.ended_at) {
        await this.db.query(
          `update in_memberships set ended_at = null where id = $1`,
          [row.id]
        );
        return { membershipId: row.id, reactivated: true };
      }
      return { membershipId: row.id, reactivated: false };
    }

    await this.db.query(
      `insert into in_memberships (id, org_id, user_id, role, ended_at, created_at) values ($1, $2, $3, 'buyer', null, now())`,
      [input.membershipId, input.orgId, input.userId]
    );
    return { membershipId: input.membershipId, reactivated: false };
  }

  async listMembers(orgId: string): Promise<Array<{
    userId: string;
    githubLogin: string;
    membershipId: string;
    isOwner: boolean;
  }>> {
    const result = await this.db.query<{
      user_id: string;
      github_login: string;
      membership_id: string;
      is_owner: boolean;
    }>(
      `select
        membership.user_id as user_id,
        u.github_login as github_login,
        membership.id as membership_id,
        (org.owner_user_id = membership.user_id) as is_owner
      from in_memberships membership
      join in_orgs org on org.id = membership.org_id
      join in_users u on u.id = membership.user_id
      where membership.org_id = $1
        and membership.ended_at is null
      order by membership.created_at asc`,
      [orgId]
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      githubLogin: row.github_login,
      membershipId: row.membership_id,
      isOwner: row.is_owner
    }));
  }
}
