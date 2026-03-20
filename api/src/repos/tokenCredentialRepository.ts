import type { SqlClient, SqlQueryResult, SqlValue, TransactionContext } from './sqlClient.js';
import { TABLES } from './tableNames.js';
import { newId } from '../utils/ids.js';
import { decryptSecret, encryptSecret } from '../utils/crypto.js';

export type TokenAuthScheme = 'x_api_key' | 'bearer';
export type TokenCredentialStatus = 'active' | 'paused' | 'rotating' | 'maxed' | 'expired' | 'revoked';

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
  five_hour_reserve_percent?: number | null;
  seven_day_reserve_percent?: number | null;
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
  fiveHourReservePercent: number;
  sevenDayReservePercent: number;
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

export type UpdateTokenCredentialContributionCapInput = {
  fiveHourReservePercent?: number;
  sevenDayReservePercent?: number;
};

type ClaudeContributionCapLifecycleTransition = 'exhausted' | 'cleared' | null;
type ClaudeContributionCapWindow = '5h' | '7d';

function currentUtcMonthStartExpr(): string {
  return "date_trunc('month', now() at time zone 'utc') at time zone 'utc'";
}

function isMissingTokenCredentialContributionCapColumns(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const details = error as { code?: string; column?: string; message?: string };
  if (details.code !== '42703') return false;
  return details.column === 'five_hour_reserve_percent'
    || details.column === 'seven_day_reserve_percent'
    || details.message?.includes('five_hour_reserve_percent') === true
    || details.message?.includes('seven_day_reserve_percent') === true;
}

function isMissingPilotAdmissionFreezeTable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const details = error as { code?: string; message?: string };
  return details.code === '42P01'
    && details.message?.includes('in_pilot_admission_freezes') === true;
}

function tokenCredentialSelectColumns(includeContributionCapColumns: boolean): string {
  const contributionCapColumns = includeContributionCapColumns
    ? `five_hour_reserve_percent,
        seven_day_reserve_percent`
    : `0::integer as five_hour_reserve_percent,
        0::integer as seven_day_reserve_percent`;

  return `
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
        ${contributionCapColumns},
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
}

async function queryTokenCredentialRowsWithSchemaFallback(
  client: TransactionContext,
  sqlFor: (input: {
    includeContributionCapColumns: boolean;
    includeFreezeJoin: boolean;
  }) => string,
  params: SqlValue[],
  input?: {
    includeContributionCapColumns?: boolean;
    includeFreezeJoin?: boolean;
  }
): Promise<SqlQueryResult<TokenCredentialRow>> {
  const settings = {
    includeContributionCapColumns: input?.includeContributionCapColumns ?? true,
    includeFreezeJoin: input?.includeFreezeJoin ?? false
  };

  try {
    return await client.query<TokenCredentialRow>(sqlFor(settings), params);
  } catch (error) {
    if (settings.includeContributionCapColumns && isMissingTokenCredentialContributionCapColumns(error)) {
      try {
        return await client.query<TokenCredentialRow>(sqlFor({
          ...settings,
          includeContributionCapColumns: false
        }), params);
      } catch (fallbackError) {
        if (!settings.includeFreezeJoin || !isMissingPilotAdmissionFreezeTable(fallbackError)) {
          throw fallbackError;
        }
        return client.query<TokenCredentialRow>(sqlFor({
          includeContributionCapColumns: false,
          includeFreezeJoin: false
        }), params);
      }
    }

    if (!settings.includeFreezeJoin || !isMissingPilotAdmissionFreezeTable(error)) {
      throw error;
    }

    try {
      return await client.query<TokenCredentialRow>(sqlFor({
        ...settings,
        includeFreezeJoin: false
      }), params);
    } catch (fallbackError) {
      if (!settings.includeContributionCapColumns || !isMissingTokenCredentialContributionCapColumns(fallbackError)) {
        throw fallbackError;
      }
      return client.query<TokenCredentialRow>(sqlFor({
        includeContributionCapColumns: false,
        includeFreezeJoin: false
      }), params);
    }
  }
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
    fiveHourReservePercent: Number(row.five_hour_reserve_percent ?? 0),
    sevenDayReservePercent: Number(row.seven_day_reserve_percent ?? 0),
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

function contributionCapLifecycleReason(
  window: ClaudeContributionCapWindow,
  transition: Exclude<ClaudeContributionCapLifecycleTransition, null>
): string {
  return transition === 'exhausted'
    ? `provider_usage_${window}_threshold_reached`
    : `provider_usage_${window}_threshold_cleared`;
}

function routingProvidersForLookup(provider: string): string[] {
  const normalized = provider.trim().toLowerCase();
  return normalized === 'openai'
    ? ['openai', 'codex']
    : [normalized];
}

function contributionCapLifecycleMetadata(input: {
  window: ClaudeContributionCapWindow;
  latestEventType: string | null;
  latestEventAt: string | Date | null;
  snapshotFetchedAt: Date;
  reservePercent: number;
  utilizationRatio: number;
  sharedThresholdPercent: number;
  resetsAt: Date | null;
}): Record<string, unknown> {
  return {
    window: input.window,
    snapshotFetchedAt: input.snapshotFetchedAt.toISOString(),
    reservePercent: input.reservePercent,
    utilizationRatio: input.utilizationRatio,
    sharedThresholdPercent: input.sharedThresholdPercent,
    resetsAt: input.resetsAt?.toISOString() ?? null,
    previousEventType: input.latestEventType,
    previousEventAt: input.latestEventAt ? new Date(input.latestEventAt).toISOString() : null
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
    const routingProviders = routingProvidersForLookup(provider);
    const sql = (input: {
      includeContributionCapColumns: boolean;
      includeFreezeJoin: boolean;
    }) => `
      select
        ${tokenCredentialSelectColumns(input.includeContributionCapColumns)}
      from ${TABLES.tokenCredentials}
      ${input.includeFreezeJoin ? `left join ${TABLES.pilotAdmissionFreezes} paf
        on paf.resource_type = 'token_credential'
        and paf.resource_id = ${TABLES.tokenCredentials}.id
        and paf.released_at is null` : ''}
      where org_id = $1
        and provider = ANY($2::text[])
        ${input.includeFreezeJoin ? 'and paf.id is null' : ''}
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

    const result = await queryTokenCredentialRowsWithSchemaFallback(this.db, sql, [orgId, routingProviders], {
      includeContributionCapColumns: true,
      includeFreezeJoin: true
    });
    return result.rows.map(mapRow);
  }

  async getById(id: string): Promise<TokenCredential | null> {
    const sql = (input: {
      includeContributionCapColumns: boolean;
      includeFreezeJoin: boolean;
    }) => `
      select
        ${tokenCredentialSelectColumns(input.includeContributionCapColumns)}
      from ${TABLES.tokenCredentials}
      where id = $1
      limit 1
    `;
    const result = await queryTokenCredentialRowsWithSchemaFallback(this.db, sql, [id]);
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
    preserveStatus?: boolean;
  }): Promise<TokenCredential | null> {
    const sql = (query: {
      includeContributionCapColumns: boolean;
      includeFreezeJoin: boolean;
    }) => `
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
        consecutive_failure_count = 0,
        last_failed_status = null,
        last_failed_at = null,
        consecutive_rate_limit_count = 0,
        last_rate_limited_at = null,
        rate_limited_until = null,
        maxed_at = case
          when $5::boolean then maxed_at
          else null
        end,
        next_probe_at = null,
        last_probe_at = now(),
        status = case
          when $5::boolean then status
          else 'active'
        end,
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
        ${query.includeContributionCapColumns
    ? `five_hour_reserve_percent,
        seven_day_reserve_percent`
    : `0::integer as five_hour_reserve_percent,
        0::integer as seven_day_reserve_percent`},
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
      input.expiresAt,
      input.preserveStatus === true
    ];

    const result = await queryTokenCredentialRowsWithSchemaFallback(this.db, sql, params);
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

  async updateDebugLabel(
    id: string,
    debugLabel: string
  ): Promise<{
    id: string;
    orgId: string;
    provider: string;
    debugLabel: string;
  } | null> {
    const sql = `
      update ${TABLES.tokenCredentials}
      set
        debug_label = $2,
        updated_at = now()
      where id = $1
        and status <> 'revoked'
      returning
        id,
        org_id,
        provider,
        debug_label
    `;

    const result = await this.db.query<{
      id: string;
      org_id: string;
      provider: string;
      debug_label: string;
    }>(sql, [id, debugLabel]);

    if (result.rowCount !== 1) {
      return null;
    }

    return {
      id: result.rows[0].id,
      orgId: result.rows[0].org_id,
      provider: result.rows[0].provider,
      debugLabel: result.rows[0].debug_label
    };
  }

  async updateContributionCap(
    id: string,
    input: UpdateTokenCredentialContributionCapInput
  ): Promise<{
    id: string;
    orgId: string;
    provider: string;
    fiveHourReservePercent: number;
    sevenDayReservePercent: number;
  } | null> {
    const sql = `
      update ${TABLES.tokenCredentials}
      set
        five_hour_reserve_percent = case
          when $2::integer is not null then $2
          else five_hour_reserve_percent
        end,
        seven_day_reserve_percent = case
          when $3::integer is not null then $3
          else seven_day_reserve_percent
        end,
        updated_at = now()
      where id = $1
        and provider in ('anthropic', 'openai', 'codex')
      returning
        id,
        org_id,
        provider,
        five_hour_reserve_percent,
        seven_day_reserve_percent
    `;

    const result = await this.db.query<{
      id: string;
      org_id: string;
      provider: string;
      five_hour_reserve_percent: number | null;
      seven_day_reserve_percent: number | null;
    }>(sql, [
      id,
      input.fiveHourReservePercent ?? null,
      input.sevenDayReservePercent ?? null
    ]);

    if (result.rowCount !== 1) {
      return null;
    }

    return {
      id: result.rows[0].id,
      orgId: result.rows[0].org_id,
      provider: result.rows[0].provider,
      fiveHourReservePercent: Number(result.rows[0].five_hour_reserve_percent ?? 0),
      sevenDayReservePercent: Number(result.rows[0].seven_day_reserve_percent ?? 0)
    };
  }

  async migrateReserveFloors(input: {
    db?: object;
    fromOrgId: string;
    toOrgId: string;
    targetUserId: string;
    cutoverId: string;
    actorUserId: string | null;
  }): Promise<{ migratedCount: number }> {
    const client = input.db && typeof input.db === 'object' && 'query' in input.db
      ? input.db as Pick<SqlClient, 'query'>
      : this.db;
    const sql = `
      select count(*)::int as count
      from ${TABLES.tokenCredentials}
      where org_id = $1
        and provider in ('anthropic', 'openai', 'codex')
    `;
    const result = await client.query<{ count: number }>(sql, [input.toOrgId]);
    return {
      migratedCount: Number(result.rows[0]?.count ?? 0)
    };
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

      let previousCredential: { id: string; status: TokenCredentialStatus; debugLabel: string | null } | null = null;
      if (input.previousCredentialId) {
        const targetSql = `
          select id, status, debug_label
          from ${TABLES.tokenCredentials}
          where id = $1
            and org_id = $2
            and provider = $3
            and status in ('active', 'maxed')
          for update
        `;
        const target = await tx.query<{ id: string; status: TokenCredentialStatus; debug_label: string | null }>(
          targetSql,
          [input.previousCredentialId, input.orgId, input.provider]
        );
        if (target.rowCount !== 1) {
          throw new Error(`Credential ${input.previousCredentialId} not found or not rotatable for org/provider`);
        }
        previousCredential = {
          id: target.rows[0].id,
          status: target.rows[0].status,
          debugLabel: target.rows[0].debug_label ?? null
        };
      } else {
        const activeSql = `
          select id, status, debug_label
          from ${TABLES.tokenCredentials}
          where org_id = $1 and provider = $2 and status = 'active'
          order by rotation_version desc
          limit 1
          for update
        `;
        const active = await tx.query<{ id: string; status: TokenCredentialStatus; debug_label: string | null }>(
          activeSql,
          [input.orgId, input.provider]
        );
        previousCredential = active.rowCount === 1
          ? {
            id: active.rows[0].id,
            status: active.rows[0].status,
            debugLabel: active.rows[0].debug_label ?? null
          }
          : null;
      }

      if (previousCredential?.status === 'active') {
        await tx.query(
          `
            update ${TABLES.tokenCredentials}
            set status = 'rotating', updated_at = now()
            where id = $1
          `,
          [previousCredential.id]
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
        input.debugLabel ?? previousCredential?.debugLabel ?? null,
        nextRotationVersion,
        input.createdBy ?? null
      ];
      await tx.query(insertSql, insertParams);

      if (previousCredential) {
        await tx.query(
          `
            update ${TABLES.tokenCredentials}
            set status = 'revoked', revoked_at = now(), updated_at = now()
            where id = $1
          `,
          [previousCredential.id]
        );
      }

      return { id: nextId, rotationVersion: nextRotationVersion, previousId: previousCredential?.id ?? null };
    });
  }

  async listActiveOauthByProvider(
    provider: string,
    options?: {
      includeRecoverableExpired?: boolean;
    }
  ): Promise<TokenCredential[]> {
    const sql = (query: {
      includeContributionCapColumns: boolean;
      includeFreezeJoin: boolean;
    }) => `
      select
        ${tokenCredentialSelectColumns(query.includeContributionCapColumns)}
      from ${TABLES.tokenCredentials}
      where provider = $1
        and (
          (
            status = 'active'
            and expires_at > now()
          )
          or (
            $2::boolean = true
            and status in ('active', 'expired')
            and expires_at <= now()
            and encrypted_refresh_token is not null
          )
        )
      order by
        case
          when expires_at > now() then 0
          else 1
        end asc,
        updated_at desc,
        rotation_version desc
    `;

    const result = await queryTokenCredentialRowsWithSchemaFallback(this.db, sql, [
      provider,
      options?.includeRecoverableExpired === true
    ]);
    return result.rows.map(mapRow);
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

  async pause(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const result = await tx.query<{
        org_id: string;
        provider: string;
        rate_limited_until: string | Date | null;
      }>(
        `
          update ${TABLES.tokenCredentials}
          set
            status = 'paused',
            updated_at = now()
          where id = $1
            and status = 'active'
          returning org_id, provider, rate_limited_until
        `,
        [id]
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
          ) values ($1,$2,$3,$4,'paused',null,$5,$6,now())
        `,
        [
          newId(),
          id,
          row.org_id,
          row.provider,
          'manual_pause',
          {
            previousStatus: 'active',
            rateLimitedUntil: row.rate_limited_until ? new Date(row.rate_limited_until).toISOString() : null,
          }
        ]
      );

      return true;
    });
  }

  async unpause(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const result = await tx.query<{
        org_id: string;
        provider: string;
        rate_limited_until: string | Date | null;
      }>(
        `
          update ${TABLES.tokenCredentials}
          set
            status = 'active',
            updated_at = now()
          where id = $1
            and status = 'paused'
          returning org_id, provider, rate_limited_until
        `,
        [id]
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
          ) values ($1,$2,$3,$4,'unpaused',null,$5,$6,now())
        `,
        [
          newId(),
          id,
          row.org_id,
          row.provider,
          'manual_unpause',
          {
            previousStatus: 'paused',
            rateLimitedUntil: row.rate_limited_until ? new Date(row.rate_limited_until).toISOString() : null,
          }
        ]
      );

      return true;
    });
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
            rate_limited_until = case
              when status = 'active'
                and coalesce(consecutive_rate_limit_count, 0) + 1 >= $4
              then greatest(coalesce(rate_limited_until, '-infinity'::timestamptz), $3)
              else rate_limited_until
            end,
            last_refresh_error = case
              when $6::text is not null then $6
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
        input.reason ?? null
      ]);
      if (result.rowCount !== 1) return null;

      const row = result.rows[0];
      return {
        status: row.status,
        consecutiveRateLimits: Number(row.consecutive_rate_limits),
        rateLimitedUntil: row.rate_limited_until ? new Date(row.rate_limited_until) : null,
        newlyMaxed: false
      };
    });
  }

  async recordRateLimitAndApplyCooldown(input: {
    id: string;
    statusCode: number;
    cooldownThreshold: number;
    cooldownUntil: Date;
    escalationThreshold: number;
    escalationCooldownUntil: Date;
    reason?: string;
  }): Promise<{
    status: TokenCredentialStatus;
    consecutiveRateLimits: number;
    rateLimitedUntil: Date | null;
    backoffKind: 'none' | 'cooldown' | 'extended';
  } | null> {
    const sql = `
      update ${TABLES.tokenCredentials}
      set
        consecutive_rate_limit_count = coalesce(consecutive_rate_limit_count, 0) + 1,
        last_rate_limited_at = now(),
        rate_limited_until = case
          when coalesce(consecutive_rate_limit_count, 0) + 1 >= $4
          then greatest(coalesce(rate_limited_until, '-infinity'::timestamptz), $5)
          when coalesce(consecutive_rate_limit_count, 0) + 1 >= $2
          then greatest(coalesce(rate_limited_until, '-infinity'::timestamptz), $3)
          else rate_limited_until
        end,
        last_refresh_error = case
          when $6::text is not null then $6
          else last_refresh_error
        end,
        updated_at = now()
      where id = $1
        and status in ('active', 'rotating', 'maxed')
      returning
        status,
        coalesce(consecutive_rate_limit_count, 0) as consecutive_rate_limits,
        rate_limited_until
    `;

    const result = await this.db.query<{
      status: TokenCredentialStatus;
      consecutive_rate_limits: number;
      rate_limited_until: string | Date | null;
    }>(sql, [
      input.id,
      input.cooldownThreshold,
      input.cooldownUntil,
      input.escalationThreshold,
      input.escalationCooldownUntil,
      input.reason ?? null
    ]);

    if (result.rowCount !== 1) {
      return null;
    }

    const row = result.rows[0];
    const consecutiveRateLimits = Number(row.consecutive_rate_limits);
    let backoffKind: 'none' | 'cooldown' | 'extended' = 'none';

    if (row.rate_limited_until) {
      if (consecutiveRateLimits >= input.escalationThreshold) {
        backoffKind = 'extended';
      } else if (consecutiveRateLimits >= input.cooldownThreshold) {
        backoffKind = 'cooldown';
      }
    }

    return {
      status: row.status,
      consecutiveRateLimits,
      rateLimitedUntil: row.rate_limited_until ? new Date(row.rate_limited_until) : null,
      backoffKind
    };
  }

  async clearRateLimitBackoff(id: string, minConsecutiveRateLimits = 0): Promise<boolean> {
    const sql = `
      update ${TABLES.tokenCredentials}
      set
        consecutive_rate_limit_count = 0,
        rate_limited_until = null,
        updated_at = now()
      where id = $1
        and status in ('active', 'rotating')
        and coalesce(consecutive_rate_limit_count, 0) >= $2
    `;
    const result = await this.db.query(sql, [id, Math.max(0, Math.floor(minConsecutiveRateLimits))]);
    return result.rowCount === 1;
  }

  async syncClaudeContributionCapLifecycle(input: {
    id: string;
    orgId: string;
    provider: string;
    snapshotFetchedAt: Date;
    fiveHourReservePercent: number;
    fiveHourUtilizationRatio: number;
    fiveHourResetsAt: Date | null;
    fiveHourSharedThresholdPercent: number;
    fiveHourContributionCapExhausted: boolean;
    sevenDayReservePercent: number;
    sevenDayUtilizationRatio: number;
    sevenDayResetsAt: Date | null;
    sevenDaySharedThresholdPercent: number;
    sevenDayContributionCapExhausted: boolean;
  }): Promise<{
    fiveHourTransition: ClaudeContributionCapLifecycleTransition;
    sevenDayTransition: ClaudeContributionCapLifecycleTransition;
  }> {
    return this.db.transaction(async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`claude_contribution_cap:${input.id}`]);

      const syncWindow = async (windowInput: {
        window: ClaudeContributionCapWindow;
        exhausted: boolean;
        reservePercent: number;
        utilizationRatio: number;
        sharedThresholdPercent: number;
        resetsAt: Date | null;
      }): Promise<ClaudeContributionCapLifecycleTransition> => {
        const latestResult = await tx.query<{ event_type: string; created_at: string | Date }>(
          `
            select event_type, created_at
            from ${TABLES.tokenCredentialEvents}
            where token_credential_id = $1::uuid
              and event_type in ('contribution_cap_exhausted', 'contribution_cap_cleared')
              and metadata->>'window' = $2
            order by created_at desc, id desc
            limit 1
          `,
          [input.id, windowInput.window]
        );

        const latestEvent = latestResult.rows[0] ?? null;
        const previouslyExhausted = latestEvent?.event_type === 'contribution_cap_exhausted';
        if (previouslyExhausted === windowInput.exhausted) {
          return null;
        }

        const transition: Exclude<ClaudeContributionCapLifecycleTransition, null> = windowInput.exhausted
          ? 'exhausted'
          : 'cleared';
        const eventType = transition === 'exhausted'
          ? 'contribution_cap_exhausted'
          : 'contribution_cap_cleared';

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
            ) values ($1,$2,$3,$4,$5,null,$6,$7,now())
          `,
          [
            newId(),
            input.id,
            input.orgId,
            input.provider,
            eventType,
            contributionCapLifecycleReason(windowInput.window, transition),
            contributionCapLifecycleMetadata({
              window: windowInput.window,
              latestEventType: latestEvent?.event_type ?? null,
              latestEventAt: latestEvent?.created_at ?? null,
              snapshotFetchedAt: input.snapshotFetchedAt,
              reservePercent: windowInput.reservePercent,
              utilizationRatio: windowInput.utilizationRatio,
              sharedThresholdPercent: windowInput.sharedThresholdPercent,
              resetsAt: windowInput.resetsAt
            })
          ]
        );

        return transition;
      };

      return {
        fiveHourTransition: await syncWindow({
          window: '5h',
          exhausted: input.fiveHourContributionCapExhausted,
          reservePercent: input.fiveHourReservePercent,
          utilizationRatio: input.fiveHourUtilizationRatio,
          sharedThresholdPercent: input.fiveHourSharedThresholdPercent,
          resetsAt: input.fiveHourResetsAt
        }),
        sevenDayTransition: await syncWindow({
          window: '7d',
          exhausted: input.sevenDayContributionCapExhausted,
          reservePercent: input.sevenDayReservePercent,
          utilizationRatio: input.sevenDayUtilizationRatio,
          sharedThresholdPercent: input.sevenDaySharedThresholdPercent,
          resetsAt: input.sevenDayResetsAt
        })
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

  async setProviderUsageWarning(
    id: string,
    warning: 'provider_usage_fetch_failed' | 'provider_usage_fetch_backoff_active' | null
  ): Promise<boolean> {
    const sql = `
      update ${TABLES.tokenCredentials}
      set
        last_refresh_error = $2,
        updated_at = now()
      where id = $1
        and (
          ($2::text is null and last_refresh_error like 'provider_usage_%')
          or ($2::text is not null and last_refresh_error is distinct from $2)
        )
    `;
    const result = await this.db.query(sql, [id, warning]);
    return result.rowCount === 1;
  }

  async listMaxedForProbe(limit: number): Promise<TokenCredential[]> {
    const sql = (query: {
      includeContributionCapColumns: boolean;
      includeFreezeJoin: boolean;
    }) => `
      select
        ${tokenCredentialSelectColumns(query.includeContributionCapColumns)}
      from ${TABLES.tokenCredentials}
      where status = 'maxed'
        and expires_at > now()
        and (next_probe_at is null or next_probe_at <= now())
      order by coalesce(next_probe_at, maxed_at, updated_at) asc
      limit $1
    `;
    const result = await queryTokenCredentialRowsWithSchemaFallback(this.db, sql, [limit]);
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
            when $3::text is null then last_refresh_error
            when $3::text like 'probe_failed:%'
              then case
                when last_refresh_error is null or last_refresh_error like 'probe_failed:%'
                then $3
                else last_refresh_error
              end
            else $3
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
