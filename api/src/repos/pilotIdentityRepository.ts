import type { SqlClient, SqlValue } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';

export type OrgRow = {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  spend_cap_minor: number | null;
  created_at: string;
  updated_at: string;
};

export type UserRow = {
  id: string;
  email: string;
  display_name: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type MembershipRole = 'admin' | 'seller' | 'buyer';

export type MembershipRow = {
  id: string;
  org_id: string;
  user_id: string;
  role: MembershipRole;
  created_at: string;
};

type OrgUserDirectoryRow = {
  org_id: string;
  org_slug: string;
  org_name: string;
  user_id: string;
  user_email: string;
  display_name: string | null;
};

export type OrgUserDirectoryEntry = {
  orgId: string;
  orgSlug: string;
  orgName: string;
  userId: string;
  userEmail: string;
  displayName: string | null;
};

export class PilotIdentityRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async ensureOrg(input: {
    slug: string;
    name: string;
  }): Promise<OrgRow> {
    const existing = await this.findOrgBySlug(input.slug);
    if (existing) return existing;

    const sql = `
      insert into ${TABLES.orgs} (
        id,
        name,
        slug,
        is_active,
        created_at,
        updated_at
      ) values (
        $1,$2,$3,true,now(),now()
      )
      returning *
    `;

    return this.expectOne<OrgRow>(sql, [
      this.createId(),
      input.name,
      input.slug
    ]);
  }

  async findOrgBySlug(slug: string): Promise<OrgRow | null> {
    const sql = `
      select *
      from ${TABLES.orgs}
      where slug = $1
      limit 1
    `;
    const result = await this.db.query<OrgRow>(sql, [slug]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async ensureUser(input: {
    email: string;
    displayName?: string | null;
  }): Promise<UserRow> {
    const existing = await this.findUserByEmail(input.email);
    if (existing) return existing;

    const sql = `
      insert into in_users (
        id,
        email,
        display_name,
        is_active,
        created_at,
        updated_at
      ) values (
        $1,$2,$3,true,now(),now()
      )
      returning *
    `;

    return this.expectOne<UserRow>(sql, [
      this.createId(),
      input.email,
      input.displayName ?? null
    ]);
  }

  async findUserByEmail(email: string): Promise<UserRow | null> {
    const sql = `
      select *
      from in_users
      where lower(email) = lower($1)
      limit 1
    `;
    const result = await this.db.query<UserRow>(sql, [email]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async ensureMembership(input: {
    orgId: string;
    userId: string;
    role: MembershipRole;
  }): Promise<MembershipRow> {
    const sql = `
      insert into in_memberships (
        id,
        org_id,
        user_id,
        role,
        created_at
      ) values (
        $1,$2,$3,$4,now()
      )
      on conflict (org_id, user_id)
      do update set
        role = excluded.role
      returning *
    `;

    return this.expectOne<MembershipRow>(sql, [
      this.createId(),
      input.orgId,
      input.userId,
      input.role
    ]);
  }

  async listOrgUserDirectoryBySlug(slug: string): Promise<OrgUserDirectoryEntry[]> {
    const sql = `
      select
        org.id as org_id,
        org.slug as org_slug,
        org.name as org_name,
        "user".id as user_id,
        "user".email as user_email,
        "user".display_name
      from ${TABLES.orgs} org
      join in_memberships membership
        on membership.org_id = org.id
      join in_users "user"
        on "user".id = membership.user_id
      where org.slug = $1
      order by lower("user".email) asc, membership.created_at asc
    `;
    const result = await this.db.query<OrgUserDirectoryRow>(sql, [slug]);
    return result.rows.map((row) => ({
      orgId: row.org_id,
      orgSlug: row.org_slug,
      orgName: row.org_name,
      userId: row.user_id,
      userEmail: row.user_email,
      displayName: row.display_name
    }));
  }

  async reassignBuyerKeysToOrg(input: {
    apiKeyIds: string[];
    targetOrgId: string;
  }): Promise<string[]> {
    if (input.apiKeyIds.length === 0) return [];

    const sql = `
      update in_api_keys
      set org_id = $2
      where id = any($1::uuid[])
      returning id
    `;
    const result = await this.db.query<{ id: string }>(sql, [input.apiKeyIds, input.targetOrgId]);
    return result.rows.map((row) => row.id);
  }

  async reassignTokenCredentialsToOrg(input: {
    tokenCredentialIds: string[];
    targetOrgId: string;
  }): Promise<string[]> {
    if (input.tokenCredentialIds.length === 0) return [];

    const sql = `
      update ${TABLES.tokenCredentials}
      set org_id = $2
      where id = any($1::uuid[])
      returning id
    `;
    const result = await this.db.query<{ id: string }>(sql, [input.tokenCredentialIds, input.targetOrgId]);
    return result.rows.map((row) => row.id);
  }

  private async expectOne<T>(sql: string, params: SqlValue[]): Promise<T> {
    const result = await this.db.query<T>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one pilot identity row');
    }
    return result.rows[0];
  }
}
