import type { TokenCredentialStatus } from './tokenCredentialRepository.js';
import type { SqlClient, TransactionContext } from './sqlClient.js';

export class OrgTokenRepository {
  constructor(private readonly db: SqlClient) {}

  async listOrgTokens(orgId: string): Promise<Array<{
    tokenId: string;
    provider: string;
    status: TokenCredentialStatus;
    createdByUserId: string;
    createdByGithubLogin: string;
    debugLabel: string | null;
    fiveHourReservePercent: number;
    sevenDayReservePercent: number;
  }>> {
    const result = await this.db.query<{
      token_id: string;
      provider: string;
      status: TokenCredentialStatus;
      created_by_user_id: string;
      created_by_github_login: string;
      debug_label: string | null;
      five_hour_reserve_percent: number;
      seven_day_reserve_percent: number;
    }>(
      `select
        tc.id as token_id,
        tc.provider,
        tc.status,
        tc.created_by as created_by_user_id,
        u.github_login as created_by_github_login,
        tc.debug_label,
        tc.five_hour_reserve_percent,
        tc.seven_day_reserve_percent
      from in_token_credentials tc
      left join in_users u on u.id = tc.created_by
      where tc.org_id = $1
        and tc.status != 'revoked'
      order by tc.created_at asc`,
      [orgId]
    );
    return result.rows.map((row) => ({
      tokenId: row.token_id,
      provider: row.provider,
      status: row.status,
      createdByUserId: row.created_by_user_id,
      createdByGithubLogin: row.created_by_github_login,
      debugLabel: row.debug_label,
      fiveHourReservePercent: row.five_hour_reserve_percent,
      sevenDayReservePercent: row.seven_day_reserve_percent
    }));
  }

  async listMemberTokens(orgId: string, userId: string): Promise<Array<{
    tokenId: string;
    provider: string;
  }>> {
    const result = await this.db.query<{
      token_id: string;
      provider: string;
    }>(
      `select
        id as token_id,
        provider
      from in_token_credentials
      where org_id = $1
        and created_by = $2
        and status != 'revoked'
      order by created_at asc`,
      [orgId, userId]
    );
    return result.rows.map((row) => ({
      tokenId: row.token_id,
      provider: row.provider
    }));
  }

  async removeMemberTokens(
    tx: TransactionContext,
    orgId: string,
    userId: string
  ): Promise<number> {
    const result = await tx.query(
      `update in_token_credentials set status = 'revoked' where org_id = $1 and created_by = $2`,
      [orgId, userId]
    );
    return result.rowCount;
  }
}
