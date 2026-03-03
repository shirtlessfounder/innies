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
  monthly_contribution_limit_units: number | null;
  monthly_contribution_used_units: number;
  monthly_window_start_at: string | Date;
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
  monthlyContributionLimitUnits: number | null;
  monthlyContributionUsedUnits: number;
  monthlyWindowStartAt: Date;
};

export type CreateTokenCredentialInput = {
  orgId: string;
  provider: string;
  authScheme: TokenAuthScheme;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt: Date;
  monthlyContributionLimitUnits?: number | null;
  createdBy?: string | null;
};

export type RotateTokenCredentialInput = {
  orgId: string;
  provider: string;
  authScheme: TokenAuthScheme;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt: Date;
  monthlyContributionLimitUnits?: number | null;
  createdBy?: string | null;
};

function currentUtcMonthStartExpr(): string {
  return "date_trunc('month', now() at time zone 'utc') at time zone 'utc'";
}

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
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    monthlyContributionLimitUnits: row.monthly_contribution_limit_units === null ? null : Number(row.monthly_contribution_limit_units),
    monthlyContributionUsedUnits: Number(row.monthly_contribution_used_units),
    monthlyWindowStartAt: new Date(row.monthly_window_start_at)
  };
}

export class TokenCredentialRepository {
  constructor(private readonly db: SqlClient) {}

  async create(input: CreateTokenCredentialInput): Promise<{ id: string; rotationVersion: number }> {
    return this.db.transaction(async (tx) => {
      const latestSql = `
        select rotation_version
        from ${TABLES.tokenCredentials}
        where org_id = $1 and provider = $2
        order by rotation_version desc
        limit 1
        for update
      `;
      const latest = await tx.query<{ rotation_version: number }>(latestSql, [input.orgId, input.provider]);
      const nextRotationVersion = (latest.rowCount === 1 ? latest.rows[0].rotation_version : 0) + 1;

      const id = newId();
      const insertSql = `
        insert into ${TABLES.tokenCredentials} (
          id,
          org_id,
          provider,
          auth_scheme,
          encrypted_access_token,
          encrypted_refresh_token,
          expires_at,
          monthly_contribution_limit_units,
          monthly_contribution_used_units,
          monthly_window_start_at,
          status,
          rotation_version,
          created_by,
          created_at,
          updated_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,0,${currentUtcMonthStartExpr()},'active',$9,$10,now(),now())
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
        input.monthlyContributionLimitUnits ?? null,
        nextRotationVersion,
        input.createdBy ?? null
      ];

      const result = await tx.query<{ id: string; rotation_version: number }>(insertSql, params);
      if (result.rowCount !== 1) throw new Error('expected one token credential row');
      return { id: result.rows[0].id, rotationVersion: result.rows[0].rotation_version };
    });
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
        updated_at,
        monthly_contribution_limit_units,
        monthly_contribution_used_units,
        monthly_window_start_at
      from ${TABLES.tokenCredentials}
      where org_id = $1
        and provider = $2
        and status = 'active'
        and expires_at > now()
        and (
          monthly_contribution_limit_units is null
          or (
            case
              when monthly_window_start_at < ${currentUtcMonthStartExpr()}
              then 0
              else monthly_contribution_used_units
            end
          ) < monthly_contribution_limit_units
        )
      order by rotation_version desc, updated_at desc
    `;

    const result = await this.db.query<TokenCredentialRow>(sql, [orgId, provider]);
    return result.rows.map(mapRow);
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
        revoked_at,
        monthly_contribution_limit_units,
        monthly_contribution_used_units,
        monthly_window_start_at
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
        monthly_contribution_used_units = case
          when monthly_window_start_at < ${currentUtcMonthStartExpr()}
          then 0
          else monthly_contribution_used_units
        end,
        monthly_window_start_at = case
          when monthly_window_start_at < ${currentUtcMonthStartExpr()}
          then ${currentUtcMonthStartExpr()}
          else monthly_window_start_at
        end,
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
        updated_at,
        monthly_contribution_limit_units,
        monthly_contribution_used_units,
        monthly_window_start_at
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
          monthly_contribution_limit_units,
          monthly_contribution_used_units,
          monthly_window_start_at,
          status,
          rotation_version,
          created_by,
          created_at,
          updated_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,0,${currentUtcMonthStartExpr()},'active',$9,$10,now(),now())
      `;

      const insertParams: SqlValue[] = [
        nextId,
        input.orgId,
        input.provider,
        input.authScheme,
        encryptSecret(input.accessToken),
        input.refreshToken ? encryptSecret(input.refreshToken) : null,
        input.expiresAt,
        input.monthlyContributionLimitUnits ?? null,
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

  async addMonthlyContributionUsage(id: string, usageUnits: number): Promise<boolean> {
    const sql = `
      update ${TABLES.tokenCredentials}
      set
        monthly_contribution_used_units = case
          when monthly_window_start_at < ${currentUtcMonthStartExpr()}
          then $2
          else monthly_contribution_used_units + $2
        end,
        monthly_window_start_at = case
          when monthly_window_start_at < ${currentUtcMonthStartExpr()}
          then ${currentUtcMonthStartExpr()}
          else monthly_window_start_at
        end,
        updated_at = now()
      where id = $1
        and status = 'active'
        and (
          monthly_contribution_limit_units is null
          or (
            case
              when monthly_window_start_at < ${currentUtcMonthStartExpr()}
              then 0
              else monthly_contribution_used_units
            end
          ) + $2 <= monthly_contribution_limit_units
        )
    `;
    const result = await this.db.query(sql, [id, usageUnits]);
    return result.rowCount === 1;
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
