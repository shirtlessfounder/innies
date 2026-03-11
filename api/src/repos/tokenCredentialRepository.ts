import type { SqlClient, SqlValue } from './sqlClient.js';
import { TABLES } from './tableNames.js';
import { newId } from '../utils/ids.js';
import { decryptSecret, encryptSecret } from '../utils/crypto.js';

export type TokenAuthScheme = 'x_api_key' | 'bearer';
export type TokenCredentialStatus = 'active' | 'rotating' | 'maxed' | 'expired' | 'revoked';

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
  debug_label: string | null;
  consecutive_failure_count?: number | null;
  consecutive_rate_limit_count?: number | null;
  last_failed_status?: number | null;
  last_failed_at?: string | Date | null;
  last_rate_limited_at?: string | Date | null;
  maxed_at?: string | Date | null;
  rate_limited_until?: string | Date | null;
  next_probe_at?: string | Date | null;
  last_probe_at?: string | Date | null;
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
  debugLabel: string | null;
  consecutiveFailureCount: number;
  consecutiveRateLimitCount: number;
  lastFailedStatus: number | null;
  lastFailedAt: Date | null;
  lastRateLimitedAt: Date | null;
  maxedAt: Date | null;
  rateLimitedUntil: Date | null;
  nextProbeAt: Date | null;
  lastProbeAt: Date | null;
};

export type CreateTokenCredentialInput = {
  orgId: string;
  provider: string;
  authScheme: TokenAuthScheme;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt: Date;
  monthlyContributionLimitUnits?: number | null;
  debugLabel?: string | null;
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
  debugLabel?: string | null;
  createdBy?: string | null;
  previousCredentialId?: string | null;
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
    monthlyWindowStartAt: new Date(row.monthly_window_start_at),
    debugLabel: row.debug_label,
    consecutiveFailureCount: Number(row.consecutive_failure_count ?? 0),
    consecutiveRateLimitCount: Number(row.consecutive_rate_limit_count ?? 0),
    lastFailedStatus: row.last_failed_status === null || row.last_failed_status === undefined ? null : Number(row.last_failed_status),
    lastFailedAt: row.last_failed_at ? new Date(row.last_failed_at) : null,
    lastRateLimitedAt: row.last_rate_limited_at ? new Date(row.last_rate_limited_at) : null,
    maxedAt: row.maxed_at ? new Date(row.maxed_at) : null,
    rateLimitedUntil: row.rate_limited_until ? new Date(row.rate_limited_until) : null,
    nextProbeAt: row.next_probe_at ? new Date(row.next_probe_at) : null,
    lastProbeAt: row.last_probe_at ? new Date(row.last_probe_at) : null
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
          debug_label,
          status,
          rotation_version,
          created_by,
          created_at,
          updated_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,0,${currentUtcMonthStartExpr()},$9,'active',$10,$11,now(),now())
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
        input.debugLabel ?? null,
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
        monthly_window_start_at,
        debug_label,
        consecutive_failure_count,
        consecutive_rate_limit_count,
        last_failed_status,
        last_failed_at,
        last_rate_limited_at,
        maxed_at,
        rate_limited_until,
        next_probe_at,
        last_probe_at
      from ${TABLES.tokenCredentials}
      where org_id = $1
        and provider = $2
        and status = 'active'
        and expires_at > now()
        and (rate_limited_until is null or rate_limited_until <= now())
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
        monthly_window_start_at,
        debug_label,
        consecutive_failure_count,
        consecutive_rate_limit_count,
        last_failed_status,
        last_failed_at,
        last_rate_limited_at,
        maxed_at,
        rate_limited_until,
        next_probe_at,
        last_probe_at
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
        consecutive_rate_limit_count = 0,
        rate_limited_until = null,
        status = 'active',
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
        monthly_window_start_at,
        debug_label,
        consecutive_failure_count,
        consecutive_rate_limit_count,
        last_failed_status,
        last_failed_at,
        last_rate_limited_at,
        maxed_at,
        rate_limited_until,
        next_probe_at,
        last_probe_at
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

  async setRefreshToken(id: string, refreshToken: string | null): Promise<boolean> {
    const sql = `
      update ${TABLES.tokenCredentials}
      set
        encrypted_refresh_token = $2,
        updated_at = now()
      where id = $1
    `;

    const result = await this.db.query(sql, [
      id,
      refreshToken ? encryptSecret(refreshToken) : null
    ]);
    return result.rowCount === 1;
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

      let previousActive: { id: string } | null = null;
      if (input.previousCredentialId) {
        const targetSql = `
          select id
          from ${TABLES.tokenCredentials}
          where id = $1 and org_id = $2 and provider = $3 and status = 'active'
          for update
        `;
        const target = await tx.query<{ id: string }>(targetSql, [input.previousCredentialId, input.orgId, input.provider]);
        if (target.rowCount !== 1) {
          throw new Error(`Credential ${input.previousCredentialId} not found or not active for org/provider`);
        }
        previousActive = target.rows[0];
      } else {
        const activeSql = `
          select id
          from ${TABLES.tokenCredentials}
          where org_id = $1 and provider = $2 and status = 'active'
          order by rotation_version desc
          limit 1
          for update
        `;
        const active = await tx.query<{ id: string }>(activeSql, [input.orgId, input.provider]);
        previousActive = active.rowCount === 1 ? active.rows[0] : null;
      }

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
          debug_label,
          status,
          rotation_version,
          created_by,
          created_at,
          updated_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,0,${currentUtcMonthStartExpr()},$9,'active',$10,$11,now(),now())
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
        input.debugLabel ?? null,
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

  async recordFailureAndMaybeMax(input: {
    id: string;
    statusCode: number;
    threshold: number;
    nextProbeAt: Date;
    reason?: string;
    requestId?: string | null;
    attemptNo?: number | null;
  }): Promise<{ status: TokenCredentialStatus; consecutiveFailures: number; newlyMaxed: boolean } | null> {
    return this.db.transaction(async (tx) => {
      const sql = `
        with previous as (
          select status, org_id, provider
          from ${TABLES.tokenCredentials}
          where id = $1
          for update
        ),
        updated as (
          update ${TABLES.tokenCredentials}
          set
            consecutive_failure_count = coalesce(consecutive_failure_count, 0) + 1,
            last_failed_status = $2,
            last_failed_at = now(),
            status = case
              when status in ('active', 'rotating')
                and coalesce(consecutive_failure_count, 0) + 1 >= $3
              then 'maxed'
              else status
            end,
            maxed_at = case
              when status in ('active', 'rotating')
                and coalesce(consecutive_failure_count, 0) + 1 >= $3
              then now()
              else maxed_at
            end,
            next_probe_at = case
              when status in ('active', 'rotating')
                and coalesce(consecutive_failure_count, 0) + 1 >= $3
              then $4
              else next_probe_at
            end,
            last_refresh_error = case
              when $5::text is not null then $5
              else last_refresh_error
            end,
            updated_at = now()
          where id = $1
            and status in ('active', 'rotating', 'maxed')
          returning
            status,
            coalesce(consecutive_failure_count, 0) as consecutive_failures,
            coalesce(monthly_contribution_used_units, 0) as monthly_contribution_used_units
        )
        select
          previous.status as previous_status,
          previous.org_id,
          previous.provider,
          updated.status,
          updated.consecutive_failures,
          updated.monthly_contribution_used_units
        from updated
        join previous on true
      `;
      const result = await tx.query<{
        previous_status: TokenCredentialStatus;
        org_id: string;
        provider: string;
        status: TokenCredentialStatus;
        consecutive_failures: number;
        monthly_contribution_used_units: number;
      }>(sql, [
        input.id,
        input.statusCode,
        input.threshold,
        input.nextProbeAt,
        input.reason ?? null
      ]);
      if (result.rowCount !== 1) return null;

      const row = result.rows[0];
      const newlyMaxed = (row.previous_status === 'active' || row.previous_status === 'rotating')
        && row.status === 'maxed';

      if (newlyMaxed) {
        await tx.query(
          `
            insert into ${TABLES.tokenCredentialEvents} (
              id,
              token_credential_id,
              org_id,
              provider,
              event_type,
              status_code,
              reason,
              metadata,
              created_at
            ) values ($1,$2,$3,$4,'maxed',$5,$6,$7,now())
          `,
          [
            newId(),
            input.id,
            row.org_id,
            row.provider,
            input.statusCode,
            input.reason ?? null,
            {
              requestId: input.requestId ?? null,
              attemptNo: input.attemptNo ?? null,
              statusCode: input.statusCode,
              threshold: input.threshold,
              consecutiveFailures: Number(row.consecutive_failures),
              monthlyContributionUsedUnits: Number(row.monthly_contribution_used_units)
            }
          ]
        );
      }

      return {
        status: row.status,
        consecutiveFailures: Number(row.consecutive_failures),
        newlyMaxed
      };
    });
  }

  async recordRateLimitAndMaybeMax(input: {
    id: string;
    statusCode: number;
    cooldownThreshold: number;
    cooldownUntil: Date;
    threshold: number;
    nextProbeAt: Date;
    forceMax?: boolean;
    reason?: string;
    requestId?: string | null;
    attemptNo?: number | null;
  }): Promise<{
    status: TokenCredentialStatus;
    consecutiveRateLimits: number;
    rateLimitedUntil: Date | null;
    newlyMaxed: boolean;
  } | null> {
    return this.db.transaction(async (tx) => {
      const sql = `
        with previous as (
          select status, org_id, provider, rate_limited_until
          from ${TABLES.tokenCredentials}
          where id = $1
          for update
        ),
        updated as (
          update ${TABLES.tokenCredentials}
          set
            consecutive_rate_limit_count = coalesce(consecutive_rate_limit_count, 0) + 1,
            last_rate_limited_at = now(),
            status = case
              when status in ('active', 'rotating')
                and ($6::boolean or coalesce(consecutive_rate_limit_count, 0) + 1 >= $4)
              then 'maxed'
              else status
            end,
            maxed_at = case
              when status in ('active', 'rotating')
                and ($6::boolean or coalesce(consecutive_rate_limit_count, 0) + 1 >= $4)
              then now()
              else maxed_at
            end,
            rate_limited_until = case
              when status = 'active'
                and not ($6::boolean or coalesce(consecutive_rate_limit_count, 0) + 1 >= $4)
                and coalesce(consecutive_rate_limit_count, 0) + 1 >= $2
              then greatest(coalesce(rate_limited_until, '-infinity'::timestamptz), $3)
              else rate_limited_until
            end,
            next_probe_at = case
              when status in ('active', 'rotating')
                and ($6::boolean or coalesce(consecutive_rate_limit_count, 0) + 1 >= $4)
              then $5
              else next_probe_at
            end,
            last_refresh_error = case
              when $7::text is not null then $7
              else last_refresh_error
            end,
            updated_at = now()
          where id = $1
            and status in ('active', 'rotating', 'maxed')
          returning
            status,
            coalesce(consecutive_rate_limit_count, 0) as consecutive_rate_limits,
            rate_limited_until
        )
        select
          previous.status as previous_status,
          previous.org_id,
          previous.provider,
          updated.status,
          updated.consecutive_rate_limits,
          updated.rate_limited_until
        from updated
        join previous on true
      `;
      const result = await tx.query<{
        previous_status: TokenCredentialStatus;
        org_id: string;
        provider: string;
        status: TokenCredentialStatus;
        consecutive_rate_limits: number;
        rate_limited_until: string | Date | null;
      }>(sql, [
        input.id,
        input.cooldownThreshold,
        input.cooldownUntil,
        input.threshold,
        input.nextProbeAt,
        Boolean(input.forceMax),
        input.reason ?? null
      ]);
      if (result.rowCount !== 1) return null;

      const row = result.rows[0];
      const newlyMaxed = (row.previous_status === 'active' || row.previous_status === 'rotating')
        && row.status === 'maxed';

      if (newlyMaxed) {
        await tx.query(
          `
            insert into ${TABLES.tokenCredentialEvents} (
              id,
              token_credential_id,
              org_id,
              provider,
              event_type,
              status_code,
              reason,
              metadata,
              created_at
            ) values ($1,$2,$3,$4,'maxed',$5,$6,$7,now())
          `,
          [
            newId(),
            input.id,
            row.org_id,
            row.provider,
            input.statusCode,
            input.reason ?? null,
            {
              requestId: input.requestId ?? null,
              attemptNo: input.attemptNo ?? null,
              statusCode: input.statusCode,
              threshold: input.threshold,
              cooldownThreshold: input.cooldownThreshold,
              consecutiveRateLimits: Number(row.consecutive_rate_limits),
              forceMax: Boolean(input.forceMax)
            }
          ]
        );
      }

      return {
        status: row.status,
        consecutiveRateLimits: Number(row.consecutive_rate_limits),
        rateLimitedUntil: row.rate_limited_until ? new Date(row.rate_limited_until) : null,
        newlyMaxed
      };
    });
  }

  async recordSuccess(id: string): Promise<boolean> {
    const sql = `
      update ${TABLES.tokenCredentials}
      set
        consecutive_failure_count = 0,
        consecutive_rate_limit_count = 0,
        last_failed_status = null,
        last_failed_at = null,
        rate_limited_until = null,
        updated_at = now()
      where id = $1
        and status in ('active', 'rotating')
    `;
    const result = await this.db.query(sql, [id]);
    return result.rowCount === 1;
  }

  async listMaxedForProbe(limit: number): Promise<TokenCredential[]> {
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
        monthly_window_start_at,
        debug_label,
        consecutive_failure_count,
        consecutive_rate_limit_count,
        last_failed_status,
        last_failed_at,
        last_rate_limited_at,
        maxed_at,
        rate_limited_until,
        next_probe_at,
        last_probe_at
      from ${TABLES.tokenCredentials}
      where status = 'maxed'
        and expires_at > now()
        and (next_probe_at is null or next_probe_at <= now())
      order by coalesce(next_probe_at, maxed_at, updated_at) asc
      limit $1
    `;
    const result = await this.db.query<TokenCredentialRow>(sql, [limit]);
    return result.rows.map(mapRow);
  }

  async markProbeFailure(id: string, nextProbeAt: Date, reason?: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const sql = `
        update ${TABLES.tokenCredentials}
        set
          last_probe_at = now(),
          next_probe_at = $2,
          last_refresh_error = case
            when $3::text is not null then $3
            else last_refresh_error
          end,
          updated_at = now()
        where id = $1
          and status = 'maxed'
        returning org_id, provider, maxed_at
      `;
      const result = await tx.query<{ org_id: string; provider: string; maxed_at: string | Date | null }>(
        sql,
        [id, nextProbeAt, reason ?? null]
      );
      if (result.rowCount !== 1) return false;

      const row = result.rows[0];
      await tx.query(
        `
          insert into ${TABLES.tokenCredentialEvents} (
            id,
            token_credential_id,
            org_id,
            provider,
            event_type,
            status_code,
            reason,
            metadata,
            created_at
          ) values ($1,$2,$3,$4,'probe_failed',null,$5,$6,now())
        `,
        [
          newId(),
          id,
          row.org_id,
          row.provider,
          reason ?? null,
          {
            nextProbeAt: nextProbeAt.toISOString(),
            previousMaxedAt: row.maxed_at ? new Date(row.maxed_at).toISOString() : null
          }
        ]
      );
      return true;
    });
  }

  async reactivateFromMaxed(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const sql = `
        update ${TABLES.tokenCredentials}
        set
          status = 'active',
          consecutive_failure_count = 0,
          consecutive_rate_limit_count = 0,
          last_failed_status = null,
          last_failed_at = null,
          rate_limited_until = null,
          next_probe_at = null,
          last_probe_at = now(),
          updated_at = now()
        where id = $1
          and status = 'maxed'
        returning org_id, provider, maxed_at, last_probe_at
      `;
      const result = await tx.query<{
        org_id: string;
        provider: string;
        maxed_at: string | Date | null;
        last_probe_at: string | Date | null;
      }>(sql, [id]);
      if (result.rowCount !== 1) return false;

      const row = result.rows[0];
      await tx.query(
        `
          insert into ${TABLES.tokenCredentialEvents} (
            id,
            token_credential_id,
            org_id,
            provider,
            event_type,
            status_code,
            reason,
            metadata,
            created_at
          ) values ($1,$2,$3,$4,'reactivated',null,null,$5,now())
        `,
        [
          newId(),
          id,
          row.org_id,
          row.provider,
          {
            previousMaxedAt: row.maxed_at ? new Date(row.maxed_at).toISOString() : null,
            probeSucceededAt: row.last_probe_at ? new Date(row.last_probe_at).toISOString() : null
          }
        ]
      );
      return true;
    });
  }
}
