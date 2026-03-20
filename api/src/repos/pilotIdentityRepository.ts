import type { SqlClient, SqlValue } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';

export type PilotOrgRow = {
  id: string;
  slug: string;
  name: string;
  is_active?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type PilotUserRow = {
  id: string;
  email: string;
  display_name: string | null;
  is_active?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type PilotMembershipRow = {
  id: string;
  org_id: string;
  user_id: string;
  role: 'admin' | 'seller' | 'buyer';
  created_at?: string;
};

export type PilotGithubIdentityRow = {
  user_id: string;
  github_user_id: string;
  github_login: string;
  github_email: string | null;
  created_at?: string;
  updated_at?: string;
};

export class PilotIdentityRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async ensureOrg(input: {
    slug: string;
    name: string;
  }): Promise<PilotOrgRow> {
    const sql = `
      insert into ${TABLES.orgs} (
        id,
        slug,
        name,
        is_active,
        created_at,
        updated_at
      ) values (
        $1,$2,$3,true,now(),now()
      )
      on conflict (slug)
      do update set
        name = excluded.name,
        is_active = true,
        updated_at = now()
      returning *
    `;

    return this.expectOne<PilotOrgRow>(sql, [
      this.createId(),
      input.slug,
      input.name
    ]);
  }

  async ensureUser(input: {
    email: string;
    displayName?: string | null;
  }): Promise<PilotUserRow> {
    const findSql = `
      select *
      from ${TABLES.users}
      where lower(email) = lower($1)
      limit 1
    `;
    const existing = await this.db.query<PilotUserRow>(findSql, [input.email]);
    if (existing.rowCount === 1) {
      return existing.rows[0];
    }

    const insertSql = `
      insert into ${TABLES.users} (
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

    return this.expectOne<PilotUserRow>(insertSql, [
      this.createId(),
      input.email,
      input.displayName ?? null
    ]);
  }

  async findOrgBySlug(slug: string): Promise<PilotOrgRow | null> {
    const sql = `
      select *
      from ${TABLES.orgs}
      where lower(slug) = lower($1)
      limit 1
    `;
    const result = await this.db.query<PilotOrgRow>(sql, [slug]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async ensureMembership(input: {
    orgId: string;
    userId: string;
    role: 'admin' | 'seller' | 'buyer';
  }): Promise<PilotMembershipRow> {
    const sql = `
      insert into ${TABLES.memberships} (
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

    return this.expectOne<PilotMembershipRow>(sql, [
      this.createId(),
      input.orgId,
      input.userId,
      input.role
    ]);
  }

  async upsertGithubIdentity(input: {
    userId: string;
    githubUserId: string;
    githubLogin: string;
    githubEmail?: string | null;
  }): Promise<PilotGithubIdentityRow> {
    const sql = `
      insert into ${TABLES.githubIdentities} (
        user_id,
        github_user_id,
        github_login,
        github_email,
        created_at,
        updated_at
      ) values (
        $1,$2,$3,$4,now(),now()
      )
      on conflict (user_id)
      do update set
        github_user_id = excluded.github_user_id,
        github_login = excluded.github_login,
        github_email = excluded.github_email,
        updated_at = now()
      returning *
    `;

    return this.expectOne<PilotGithubIdentityRow>(sql, [
      input.userId,
      input.githubUserId,
      input.githubLogin,
      input.githubEmail ?? null
    ]);
  }

  async findGithubIdentityByLogin(githubLogin: string): Promise<PilotGithubIdentityRow | null> {
    const sql = `
      select *
      from ${TABLES.githubIdentities}
      where lower(github_login) = lower($1)
      limit 1
    `;
    const result = await this.db.query<PilotGithubIdentityRow>(sql, [githubLogin]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  private async expectOne<T>(sql: string, params: SqlValue[]): Promise<T> {
    const result = await this.db.query<T>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one pilot identity row');
    }
    return result.rows[0];
  }
}
