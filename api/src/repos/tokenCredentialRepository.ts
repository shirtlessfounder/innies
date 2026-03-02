import type { SqlClient, SqlValue } from './sqlClient.js';
import { TABLES } from './tableNames.js';
import { newId } from '../utils/ids.js';
import { decryptSecret, encryptSecret } from '../utils/crypto.js';

export type TokenAuthScheme = 'x_api_key' | 'bearer';
export type TokenCredentialStatus = 'active' | 'rotating' | 'expired' | 'revoked';

type TokenCredentialRow = {
  id: string;
  org_id: string;
  provider: string;
  auth_scheme: TokenAuthScheme;
  encrypted_access_token: Buffer | string;
  encrypted_refresh_token: Buffer | string | null;
  expires_at: string | Date;
  status: TokenCredentialStatus;
  rotation_version: number;
  created_at: string | Date;
  updated_at: string | Date;
  revoked_at: string | Date | null;
};

export type TokenCredential = {
  id: string;
  orgId: string;
  provider: string;
  authScheme: TokenAuthScheme;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  status: TokenCredentialStatus;
  rotationVersion: number;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
};

export type CreateTokenCredentialInput = {
  orgId: string;
  provider: string;
  authScheme: TokenAuthScheme;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt: Date;
  createdBy?: string | null;
};

export type RotateTokenCredentialInput = {
  orgId: string;
  provider: string;
  authScheme: TokenAuthScheme;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt: Date;
  createdBy?: string | null;
};

function mapRow(row: TokenCredentialRow): TokenCredential {
  return {
    id: row.id,
    orgId: row.org_id,
    provider: row.provider,
    authScheme: row.auth_scheme,
    accessToken: decryptSecret(row.encrypted_access_token),
    refreshToken: row.encrypted_refresh_token ? decryptSecret(row.encrypted_refresh_token) : null,
    expiresAt: new Date(row.expires_at),
    status: row.status,
    rotationVersion: Number(row.rotation_version),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null
  };
}

export class TokenCredentialRepository {
  constructor(private readonly db: SqlClient) {}

  async existsForOrgProvider(orgId: string, provider: string): Promise<boolean> {
    const sql = `
      select 1
      from ${TABLES.tokenCredentials}
      where org_id = $1 and provider = $2
      limit 1
    `;
    const result = await this.db.query(sql, [orgId, provider]);
    return result.rowCount > 0;
  }

  async create(input: CreateTokenCredentialInput): Promise<{ id: string; rotationVersion: number }> {
    const id = newId();
    const sql = `
      insert into ${TABLES.tokenCredentials} (
        id,
        org_id,
        provider,
        auth_scheme,
        encrypted_access_token,
        encrypted_refresh_token,
        expires_at,
        status,
        rotation_version,
        created_by,
        created_at,
        updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,'active',1,$8,now(),now())
      returning id, rotation_version
    `;
    const params: SqlValue[] = [
      id,
      input.orgId,
      input.provider,
      input.authScheme,
      encryptSecret(input.accessToken),
      input.refreshToken ? encryptSecret(input.refreshToken) : null,
      input.expiresAt,
      input.createdBy ?? null
    ];
    const result = await this.db.query<{ id: string; rotation_version: number }>(sql, params);
    if (result.rowCount !== 1) throw new Error('expected one token credential row');
    return { id: result.rows[0].id, rotationVersion: result.rows[0].rotation_version };
  }

  async listActiveForRouting(orgId: string, provider: string): Promise<TokenCredential[]> {
    const sql = `
      select
        id,
        org_id,
        provider,
        auth_scheme,
        encrypted_access_token,
        encrypted_refresh_token,
        expires_at,
        status,
        rotation_version,
        created_at,
        revoked_at,
        updated_at
      from ${TABLES.tokenCredentials}
      where org_id = $1
        and provider = $2
        and status = 'active'
        and expires_at > now()
      order by rotation_version desc, updated_at desc
    `;

    const result = await this.db.query<TokenCredentialRow>(sql, [orgId, provider]);
    return result.rows.map(mapRow);
  }

  async selectActive(orgId: string, provider: string): Promise<TokenCredential | null> {
    const list = await this.listActiveForRouting(orgId, provider);
    return list[0] ?? null;
  }

  async getById(id: string): Promise<TokenCredential | null> {
    const sql = `
      select
        id,
        org_id,
        provider,
        auth_scheme,
        encrypted_access_token,
        encrypted_refresh_token,
        expires_at,
        status,
        rotation_version,
        created_at,
        updated_at,
        revoked_at
      from ${TABLES.tokenCredentials}
      where id = $1
      limit 1
    `;
    const result = await this.db.query<TokenCredentialRow>(sql, [id]);
    if (result.rowCount !== 1) return null;
    return mapRow(result.rows[0]);
  }

  async markExpired(id: string, errorMessage?: string): Promise<boolean> {
    const sql = `
      update ${TABLES.tokenCredentials}
      set status = 'expired',
          last_refresh_error = $2,
          updated_at = now()
      where id = $1 and status in ('active', 'rotating')
    `;
    const result = await this.db.query(sql, [id, errorMessage ?? null]);
    return result.rowCount === 1;
  }

  async refreshInPlace(input: {
    id: string;
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date | null;
  }): Promise<TokenCredential | null> {
    const sql = `
      update ${TABLES.tokenCredentials}
      set
        encrypted_access_token = $2,
        encrypted_refresh_token = $3,
        expires_at = $4,
        status = 'active',
        rotation_version = rotation_version + 1,
        rotated_at = now(),
        updated_at = now()
      where id = $1
      returning
        id,
        org_id,
        provider,
        auth_scheme,
        encrypted_access_token,
        encrypted_refresh_token,
        expires_at,
        status,
        rotation_version,
        created_at,
        revoked_at,
        updated_at
    `;

    const params: SqlValue[] = [
      input.id,
      encryptSecret(input.accessToken),
      input.refreshToken ? encryptSecret(input.refreshToken) : null,
      input.expiresAt
    ];

    const result = await this.db.query<TokenCredentialRow>(sql, params);
    if (result.rowCount !== 1) return null;
    return mapRow(result.rows[0]);
  }

  async rotate(input: RotateTokenCredentialInput): Promise<{ id: string; rotationVersion: number; previousId: string | null }> {
    return this.db.transaction(async (tx) => {
      const latestSql = `
        select id, rotation_version
        from ${TABLES.tokenCredentials}
        where org_id = $1 and provider = $2
        order by rotation_version desc
        limit 1
        for update
      `;
      const latest = await tx.query<{ id: string; rotation_version: number }>(latestSql, [input.orgId, input.provider]);
      const latestRow = latest.rowCount === 1 ? latest.rows[0] : null;
      const nextRotationVersion = (latestRow?.rotation_version ?? 0) + 1;

      const activeSql = `
        select id
        from ${TABLES.tokenCredentials}
        where org_id = $1 and provider = $2 and status = 'active'
        order by rotation_version desc
        limit 1
        for update
      `;
      const active = await tx.query<{ id: string }>(activeSql, [input.orgId, input.provider]);
      const previousActive = active.rowCount === 1 ? active.rows[0] : null;

      if (previousActive) {
        await tx.query(
          `
            update ${TABLES.tokenCredentials}
            set status = 'rotating', updated_at = now()
            where id = $1
          `,
          [previousActive.id]
        );
      }

      const nextId = newId();
      const insertSql = `
        insert into ${TABLES.tokenCredentials} (
          id,
          org_id,
          provider,
          auth_scheme,
          encrypted_access_token,
          encrypted_refresh_token,
          expires_at,
          status,
          rotation_version,
          created_by,
          created_at,
          updated_at
        ) values ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,now(),now())
      `;

      const insertParams: SqlValue[] = [
        nextId,
        input.orgId,
        input.provider,
        input.authScheme,
        encryptSecret(input.accessToken),
        input.refreshToken ? encryptSecret(input.refreshToken) : null,
        input.expiresAt,
        nextRotationVersion,
        input.createdBy ?? null
      ];
      await tx.query(insertSql, insertParams);

      if (previousActive) {
        await tx.query(
          `
            update ${TABLES.tokenCredentials}
            set status = 'revoked', revoked_at = now(), updated_at = now()
            where id = $1
          `,
          [previousActive.id]
        );
      }

      return { id: nextId, rotationVersion: nextRotationVersion, previousId: previousActive?.id ?? null };
    });
  }

  async revoke(id: string): Promise<boolean> {
    const sql = `
      update ${TABLES.tokenCredentials}
      set status = 'revoked',
          revoked_at = now(),
          updated_at = now()
      where id = $1 and status <> 'revoked'
    `;
    const result = await this.db.query(sql, [id]);
    return result.rowCount === 1;
  }
}
